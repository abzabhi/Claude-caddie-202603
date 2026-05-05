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

import { geomCreateMap, geomRenderPath, geomRenderPaths, geomDistanceYds, geomBearingDeg,
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
    this._onWaypointsChange = opts.onWaypointsChange || null;   /* multi-aim only */

    this._multiAim   = !!opts.multiAim;
    this._styleMode  = (opts.styleMode === 'plain') ? 'plain' : 'satellite';

    /* Multi-aim state: 3 paths, each an array of [lng,lat] waypoints. */
    this._waypoints  = [[], [], []];
    this._pathVis    = [true, true, true];
    this._activePath = 0;

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
    /* LR-EXTRAS: shot-tracker integration. _aimLocked freezes the aim reticle
       in place while a shot is armed (so a second tap is interpreted as a
       landing tap by the consumer, not as an aim move). _lineStartOverride
       pins the aim-line's start point to the armed-shot's start coordinate
       rather than live GPS, so the line stays put as the user walks toward
       the ball during shot logging. */
    this._aimLocked         = false;
    this._lineStartOverride = null;

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
      /* VIZMAP-3 -- hole-axis source/layer for static tee->green reference line.
         Created only when _multiAim is true (viz consumer); never created for
         live-round single-aim. Drawn as thin grey dashed line, non-interactive. */
      var applyHoleAxis = function(){
        if (!self._multiAim) return;
        try {
          if (!self._map.getSource('hole-axis')) {
            self._map.addSource('hole-axis', {
              type: 'geojson',
              data: { type: 'FeatureCollection', features: [] }
            });
            self._map.addLayer({
              id: 'path-axis-line',
              type: 'line',
              source: 'hole-axis',
              paint: {
                'line-color': '#888',
                'line-width': 1.5,
                'line-dasharray': [3, 3],
                'line-opacity': 0.6
              }
            });
          }
        } catch(e) {}
      };
      this._map.on('load', function(){
        applyPolys();
        applyHoleAxis();
        if (self._styleMode === 'plain') {
          try { self._map.setLayoutProperty('esri-imagery', 'visibility', 'none'); } catch(e) {}
        }
        self._showHoleInternal(self._holeN);
        self._placeTeeMarker();
        self._placeAimMarker();
        self._renderAimLine();
        self._updateFloatingDists();
        self._renderRadials();
      });
      if (this._map.isStyleLoaded && this._map.isStyleLoaded()) {
        applyPolys();
        applyHoleAxis();
        if (this._styleMode === 'plain') {
          try { this._map.setLayoutProperty('esri-imagery', 'visibility', 'none'); } catch(e) {}
        }
        this._showHoleInternal(this._holeN);
        this._placeTeeMarker();
        this._placeAimMarker();
        this._renderAimLine();
        this._updateFloatingDists();
        this._renderRadials();
      }
      this._map.on('click', this._handleMapClick);
      /* G2b-R -- floating aim-distance bubble tracks aim marker on map move/zoom. */
      this._map.on('move', this._handleMapMove);
    } else {
      /* Same instance being re-shown (e.g. after hole change returns scroll html) */
      /* PHASE-B3: Re-fly to current hole BEFORE re-placing markers. Without this,
         markers project against the prior view's center/zoom -> visible offset
         until the user toggles to scoring and back. Cheap call (no-op if already
         showing this hole). */
      this._showHoleInternal(this._holeN);
      this._placeTeeMarker();
      this._placeAimMarker();
      this._renderAimLine();
      this._updateFloatingDists();
      this._renderRadials();
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
    var btn = document.getElementById(this._idPrefix + 'RadialsToggle');
    if (btn && btn.parentNode) { try { btn.parentNode.removeChild(btn); } catch(e) {} }
    this._waypoints = [[], [], []];
    this._pathVis   = [true, true, true];
    this._activePath = 0;
    /* VIZMAP-3 -- clear hole-axis source if it exists (defensive; map.remove()
       below destroys everything anyway, but belt+suspenders for re-mount). */
    try {
      if (this._map && this._map.getSource && this._map.getSource('hole-axis')) {
        this._map.getSource('hole-axis').setData({ type: 'FeatureCollection', features: [] });
      }
    } catch(e) {}
    /* PHASE-FIX 3.2: explicit listener detach before map.remove() to prevent
       potential reference leaks. Handlers are bound on construction (lines 86-87)
       so .off() with same reference works. */
    if (this._map) {
      try { this._map.off('click', this._handleMapClick); } catch(e) {}
      try { this._map.off('move',  this._handleMapMove);  } catch(e) {}
    }
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

  setStyleMode(mode) {
    this._styleMode = (mode === 'plain') ? 'plain' : 'satellite';
    if (!this._map) return;
    try {
      this._map.setLayoutProperty('esri-imagery', 'visibility',
        this._styleMode === 'plain' ? 'none' : 'visible');
    } catch(e) {}
  }

  getStyleMode() { return this._styleMode; }

  getMap() { return this._map; }

  /* showHole(holeN, opts):
     - holeN: 1-indexed hole number
     - opts.resetAim: if true, clears the aim so next placeAimMarker picks midpoint
  */
  showHole(holeN, opts) {
    this._holeN = holeN;
    /* LR-EXTRAS: any per-shot overlay state belongs to the prior hole. Clear it
       unconditionally on hole change. The shot tracker itself is cancelled by
       the live-round hook (lrGoHole -> stCancel); these calls clear the visual
       overlay so a stale red marker / dispersion lines don't carry across. */
    this._aimLocked         = false;
    this._lineStartOverride = null;
    if (typeof this.clearDispersionLines === 'function') {
      try { this.clearDispersionLines(); } catch(e) {}
    }
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
      this._renderRadials();
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
      } else if (this._geo.bounds) {
        // CDN-MIGRATION / incomplete-course protocol: no hole context but course
        // boundary/polygons present. Fit camera to overall bounds so the user can
        // see the course and use the GPS marker + manual reticle for yardages.
        this._map.fitBounds(this._geo.bounds, { padding: 40, duration: 0, bearing: 0, pitch: 0 });
      } else if (this._geo.center) {
        // Last resort: just center on the course centroid.
        this._map.flyTo({ center: this._geo.center, zoom: 15, bearing: 0, pitch: 0 });
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
    this._renderRadials();
    if (this._onAimChange) { try { this._onAimChange(lngLat); } catch(e) {} }
  }

  getAim() { return this._aim; }

  clearAim() {
    this._aim = null;
    if (this._aimMarker) { try { this._aimMarker.remove(); } catch(e) {} this._aimMarker = null; }
    if (this._map) { try { geomRenderPath(this._map, []); } catch(e) {} }
    this._updateFloatingDists();
    this._renderRadials();
  }

  /* ============================================================
     Multi-aim chain (opt-in via opts.multiAim)
     ============================================================ */

  setWaypoints(pathIdx, arr) {
    if (pathIdx < 0 || pathIdx > 2) return;
    this._waypoints[pathIdx] = (arr || []).slice();
    this._renderAimLine();
    this._renderRadials();
    this._updateFloatingDists();
  }

  getWaypoints(pathIdx) {
    if (pathIdx < 0 || pathIdx > 2) return [];
    return this._waypoints[pathIdx].slice();
  }

  addWaypoint(pathIdx, lngLat) {
    if (pathIdx < 0 || pathIdx > 2) return;
    if (!lngLat || lngLat.length !== 2) return;
    this._waypoints[pathIdx].push([lngLat[0], lngLat[1]]);
    this._renderAimLine();
    this._renderRadials();
    this._updateFloatingDists();
    if (this._onWaypointsChange) {
      try { this._onWaypointsChange(pathIdx, this._waypoints[pathIdx].slice()); } catch(e) {}
    }
  }

  removeWaypoint(pathIdx, idx) {
    if (pathIdx < 0 || pathIdx > 2) return;
    if (idx < 0 || idx >= this._waypoints[pathIdx].length) return;
    this._waypoints[pathIdx].splice(idx, 1);
    this._renderAimLine();
    this._renderRadials();
    this._updateFloatingDists();
    if (this._onWaypointsChange) {
      try { this._onWaypointsChange(pathIdx, this._waypoints[pathIdx].slice()); } catch(e) {}
    }
  }

  clearWaypoints(pathIdx) {
    if (pathIdx < 0 || pathIdx > 2) return;
    this._waypoints[pathIdx] = [];
    this._renderAimLine();
    this._renderRadials();
    this._updateFloatingDists();
    if (this._onWaypointsChange) {
      try { this._onWaypointsChange(pathIdx, []); } catch(e) {}
    }
  }

  setActivePathIdx(idx) {
    if (idx < 0 || idx > 2) return;
    this._activePath = idx;
  }

  getActivePathIdx() { return this._activePath; }

  setPathVisible(pathIdx, vis) {
    if (pathIdx < 0 || pathIdx > 2) return;
    this._pathVis[pathIdx] = !!vis;
    this._renderAimLine();
  }

  getPathVisible(pathIdx) {
    if (pathIdx < 0 || pathIdx > 2) return false;
    return !!this._pathVis[pathIdx];
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
    if (!hole) return;
    var teePt = hole.tee || (hole.line && hole.line[0]) || null;
    if (!teePt) return;
    var ll = this._teeOverride || teePt;
    if (this._teeMarker) { try { this._teeMarker.remove(); } catch(e) {} this._teeMarker = null; }
    var el = document.createElement('div');
    /* LR-EXTRAS: box-sizing:border-box so the 2px border is inside the 14px
       dimensions; otherwise visible element is 18x18 while anchored as 14x14,
       producing the same ~2px offset the reticle had. */
    el.style.cssText = 'width:14px;height:14px;background:#d0d8e0;box-sizing:border-box;'
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
    if (this._multiAim) return;  /* viz consumer manages waypoint markers itself */
    if (!this._map || !window.maplibregl) return;
    var hole = this._curHoleGeo();
    if (!hole || !hole.green) return;
    var startPt = this._teeOverride || hole.tee || (hole.line && hole.line[0]) || null;
    if (!startPt && !hole.line) return;
    /* Initialize aim at exact midpoint along hole centreline; fall back to tee->green midpoint. */
    if (!this._aim) {
      if (hole.line && hole.line.length >= 2 && window.turf) {
        try {
          var ls   = window.turf.lineString(hole.line);
          var half = window.turf.length(ls, { units: 'kilometers' }) / 2;
          this._aim = window.turf.along(ls, half, { units: 'kilometers' }).geometry.coordinates;
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
    /* LR-EXTRAS: box-sizing:border-box is REQUIRED. Without it, the 2px border
       sits OUTSIDE the 44px content box, making the visible element 48x48 while
       MapLibre still anchors as if it were 44x44 — producing a ~2px offset of
       the visible circle and crosshair from the geographic point. With
       border-box, the border is included WITHIN the 44px dimensions and the
       visible reticle aligns with the anchor exactly. */
    el.style.cssText = 'width:33px;height:33px;border-radius:50%;box-sizing:border-box;'
      + 'border:2px solid #fff;background:rgba(255,255,255,.08);'
      + 'box-shadow:0 0 6px rgba(0,0,0,.6);cursor:grab;position:relative';
    el.innerHTML = ''
      + '<div style="position:absolute;left:50%;top:50%;width:4px;height:4px;'
      +   'background:#fff;border-radius:50%;transform:translate(-50%,-50%);'
      +   'box-shadow:0 0 3px rgba(0,0,0,.6)"></div>'
      /* 4 tick marks */
      + '<div style="position:absolute;left:50%;top:0;width:2px;height:4px;background:#fff;transform:translateX(-50%)"></div>'
      + '<div style="position:absolute;left:50%;bottom:0;width:2px;height:4px;background:#fff;transform:translateX(-50%)"></div>'
      + '<div style="position:absolute;top:50%;left:0;width:4px;height:2px;background:#fff;transform:translateY(-50%)"></div>'
      + '<div style="position:absolute;top:50%;right:0;width:4px;height:2px;background:#fff;transform:translateY(-50%)"></div>';
    var self = this;
    /* LR-EXTRAS: explicit anchor:'center' forces MapLibre to place the marker's
       geometric centre at the geographic point. Some MapLibre versions silently
       fall back to anchor:'bottom' for custom-element markers, which puts the
       crosshair (visually at element centre) BELOW the geo point — exactly the
       offset the user reported in GPS view. */
    this._aimMarker = new window.maplibregl.Marker({ element: el, draggable: true, anchor: 'center' })
      .setLngLat(this._aim).addTo(this._map);
    this._aimMarker.on('drag', function(){
      var p = self._aimMarker.getLngLat();
      self._aim = [p.lng, p.lat];
      self._renderAimLine();
      self._updateFloatingDists();
      self._renderRadials();
    });
    this._aimMarker.on('dragend', function(){
      var p = self._aimMarker.getLngLat();
      self._aim = [p.lng, p.lat];
      if (self._onAimChange) { try { self._onAimChange(self._aim); } catch(e) {} }
    });
    /* LR-EXTRAS: ensure marker style/draggability matches current lock state.
       Important when MapView rebuilds on container change mid-shot — without
       this the rebuilt marker would start in unlocked (white, draggable) state
       even if a shot is still armed. */
    this._updateAimMarkerStyle();
  }

  /* G2b-R -- render the aim line: start(GPS|userTee|geomTee) -> aim -> green. */
  _renderAimLine() {
    if (!this._map || !this._geo) return;
    var hole = this._curHoleGeo();
    if (!hole) { try { geomRenderPath(this._map, []); } catch(e){} return; }

    if (this._multiAim) {
      /* Multi-aim: render up to 3 chains. Each chain starts at tee (or override),
         then waypoints in order. Green is NOT auto-appended — chain ends at last waypoint.
         Hidden paths are skipped. */
      var teePt = this._teeOverride || hole.tee || (hole.line && hole.line[0]);
      if (!teePt) { try { geomRenderPath(this._map, []); } catch(e){} return; }
      /* VIZMAP-3 -- populate hole-axis source with tee->green reference line.
         Respects teeOverride (line follows draggable tee). */
      try {
        var axisSrc = this._map.getSource('hole-axis');
        if (axisSrc) {
          if (hole.green) {
            axisSrc.setData(window.turf.featureCollection([
              window.turf.lineString([teePt, hole.green])
            ]));
          } else {
            axisSrc.setData({ type: 'FeatureCollection', features: [] });
          }
        }
      } catch(e) {}
      var pathsArr = [];
      for (var i = 0; i < 3; i++) {
        if (!this._pathVis[i]) continue;
        var wps = this._waypoints[i];
        if (!wps || !wps.length) continue;
        var pts = [teePt];
        for (var j = 0; j < wps.length; j++) pts.push(wps[j]);
        pathsArr.push({ points: pts, pathIdx: i });
      }
      try { geomRenderPaths(this._map, pathsArr); } catch(e) {}
      return;
    }

    /* Single-aim (legacy) — behavior unchanged below. */
    if (!hole.green) { try { geomRenderPath(this._map, []); } catch(e){} return; }
    var gpsActive = !!(this._gpsOn && this._userLonLat);
    /* LR-EXTRAS: when a shot is armed, _lineStartOverride pins the line start
       to the armed-shot's start position, so the line doesn't wobble with GPS
       jitter while the user walks toward the ball. Falls through to the
       original GPS|tee logic when no override is set. */
    var startPt = this._lineStartOverride
      ? this._lineStartOverride
      : (gpsActive ? this._userLonLat : (this._teeOverride || hole.tee));
    /* // BEFORE LR-EXTRAS:
    // var startPt = gpsActive ? this._userLonLat : (this._teeOverride || hole.tee);
    */
    var aim = this._aim;
    if (!startPt || !aim) { try { geomRenderPath(this._map, []); } catch(e){} return; }
    try { geomRenderPath(this._map, [startPt, aim, hole.green]); } catch(e) {}
  }

  /* G2b-R -- update the two floating labels.
     #<idPrefix>AimDistBubble: yards from aim to green, positioned at aim's screen coords.
     #<idPrefix>PlayerDistPill: yards from start(GPS|Tee) to aim, bottom-left label. */
  _updateFloatingDists() {
    if (this._multiAim) return;  /* viz consumer renders its own distance UI */
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


    /* Tee->aim + GPS->aim: positioned below the reticle, same projection as bubble. */
    if (pill && aim) {
      var teePt  = this._teeOverride || hole.tee || (hole.line && hole.line[0]) || null;
      var teeToAim = (teePt && aim) ? geomDistanceYds(teePt, aim) : null;
      /* PHASE-FIX 3.1: When _lineStartOverride is active (ball position from
         last shot), use it for the distance and label as "Ball". Otherwise
         use raw GPS and label as "GPS". Aligns the pill value with the
         dispersion line drawn from _lineStartOverride. */
      var distFromPt = null;
      var distLabel = '';
      if (this._lineStartOverride) {
        distFromPt = this._lineStartOverride;
        distLabel = 'Ball';
      } else if (this._gpsOn && this._userLonLat) {
        distFromPt = this._userLonLat;
        distLabel = 'GPS';
      }
      var gpsToAim = distFromPt ? geomDistanceYds(distFromPt, aim) : null;
      pill.innerHTML = ''
        + '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">'
        +   '<span style="background:#111;color:#fff;border-radius:999px;padding:2px 8px;font-size:.67rem;font-weight:700">'
        +     (teeToAim === null ? '\u2014' : teeToAim + 'y') + '</span>'
        +   '<span style="font-size:.55rem;color:#555">' + (this._teeOverride ? 'tee\u2217' : 'tee') + '</span>'
        + '</div>'
        + (gpsToAim !== null
          ? '<div style="display:flex;align-items:center;gap:6px;margin-top:3px;white-space:nowrap">'
          +   '<span style="background:#1a7f4b;color:#fff;border-radius:999px;padding:2px 8px;font-size:.67rem;font-weight:700">'
          +     gpsToAim + 'y</span>'
          +   '<span style="font-size:.55rem;color:#555">' + distLabel + '</span>'
          + '</div>'
          : '');
      /* Position below reticle — clear bottom/left anchoring from live-round template. */
      try {
        var pp = this._map.project(aim);
        pill.style.position  = 'absolute';
        pill.style.left      = (pp.x - 40) + 'px';
        pill.style.top       = (pp.y + 28) + 'px';
        pill.style.bottom    = 'auto';
        pill.style.background = 'rgba(255,255,255,.92)';
        pill.style.borderRadius = '8px';
        pill.style.padding   = '5px 8px';
        pill.style.display   = 'flex';
        pill.style.flexDirection = 'column';
        pill.style.alignItems = 'flex-start';
        pill.style.gap       = '0';
        pill.style.boxShadow = '0 2px 8px rgba(0,0,0,.35)';
      } catch(e) { pill.style.display = 'none'; }
    } else if (pill) {
      pill.style.display = 'none';
    }
  }

  /* G2b-R -- tap-to-move aim. Cheaper than dragging for small adjustments. */
  _handleMapClick(e) {
    if (this._multiAim) {
      /* Multi-aim: append to active path's waypoints */
      this.addWaypoint(this._activePath, [e.lngLat.lng, e.lngLat.lat]);
      if (this._onMapClick) { try { this._onMapClick(e); } catch(err) {} }
      return;
    }
    /* LR-EXTRAS: when aim is locked (a shot is armed), the second tap is a
       LANDING tap — do not mutate aim, do not fire onAimChange. Only surface
       the click to the consumer via onMapClick so gps-view's wrap can call
       stCloseShot. */
    if (this._aimLocked) {
      if (this._onMapClick) { try { this._onMapClick(e); } catch(err) {} }
      return;
    }
    /* Single-aim (legacy) — behavior unchanged */
    this._aim = [e.lngLat.lng, e.lngLat.lat];
    if (this._aimMarker) {
      try { this._aimMarker.setLngLat(this._aim); } catch(err) {}
    } else {
      this._placeAimMarker();
    }
    this._renderAimLine();
    this._updateFloatingDists();
    this._renderRadials();
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

  /* ============================================================
     Distance radials (green rings + aim arcs) -- always rendered
     ============================================================ */

  _ensureRadialLayer() {
    if (!this._map) return;
    try {
      if (!this._map.getSource('mv-radials')) {
        this._map.addSource('mv-radials', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!this._map.getLayer('mv-radials-line')) {
        this._map.addLayer({
          id: 'mv-radials-line',
          type: 'line',
          source: 'mv-radials',
          paint: {
            'line-color': '#ffffff',
            'line-width': 1.5,
            'line-opacity': 0.7
          }
        });
      }
    } catch(e) {}
  }

  _renderRadials() {
    if (this._multiAim) return;  /* viz consumer renders per-node visualisations itself */
    if (!this._map) return;
    this._ensureRadialLayer();
    var src;
    try { src = this._map.getSource('mv-radials'); } catch(e) { return; }
    if (!src) return;
    if (!window.turf) {
      try { src.setData({ type: 'FeatureCollection', features: [] }); } catch(e) {}
      return;
    }
    var feats = [];
    var hole = this._curHoleGeo();
    /* Green rings: 15/30/45 ft */
    if (hole && hole.green) {
      var rFt = [15, 30, 45];
      for (var i = 0; i < rFt.length; i++) {
        try {
          var c = window.turf.circle(hole.green, rFt[i], { units: 'feet', steps: 64 });
          /* Convert polygon to line for cleaner stroke */
          feats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: c.geometry.coordinates[0] },
            properties: {}
          });
        } catch(e) {}
      }
    }
    /* Aim arcs: 7 perpendicular segments at offsets -30..+30 yd.
       Lengths: d=0->60, |d|=10->60, |d|=20->50, |d|=30->40 (yards). */
    if (this._aim && hole && hole.green) {
      try {
        var brgAimToGreen = geomBearingDeg(this._aim, hole.green);
        var perp = brgAimToGreen + 90;
        var offsets = [-30, -20, -10, 0, 10, 20, 30];
        var lenByAbs = { 0: 60, 10: 60, 20: 50, 30: 40 };
        for (var j = 0; j < offsets.length; j++) {
          var d = offsets[j];
          var L = lenByAbs[Math.abs(d)];
          /* Center point: positive d = past aim (toward green), negative d = short of aim.
             Use brg+180 with positive distance for negative d to avoid turf negative-distance ambiguity. */
          var centerBrg = (d >= 0) ? brgAimToGreen : (brgAimToGreen + 180);
          var center = (d === 0) ? this._aim
            : window.turf.destination(this._aim, Math.abs(d), centerBrg, { units: 'yards' }).geometry.coordinates;
          var endA = window.turf.destination(center, L / 2, perp,        { units: 'yards' }).geometry.coordinates;
          var endB = window.turf.destination(center, L / 2, perp + 180,  { units: 'yards' }).geometry.coordinates;
          feats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [endA, endB] },
            properties: {}
          });
        }
      } catch(e) {}
    }
    try { src.setData({ type: 'FeatureCollection', features: feats }); } catch(e) {}
  }

  /* ============================================================
     LR-EXTRAS: shot-tracker integration methods
     ============================================================ */

  /* Lock/unlock the aim reticle. When locked: drag is disabled, marker turns red,
     and _handleMapClick stops mutating _aim (taps go through onMapClick only).
     Used by gps-view.js while a shot is armed so the aim point captured at arm
     time is preserved as the user taps a separate landing location. */
  setAimLocked(b) {
    this._aimLocked = !!b;
    this._updateAimMarkerStyle();
  }

  /* Pin the aim line's start point to a specific [lng,lat] (typically the
     armed-shot start position) instead of live GPS. Pass null to release.
     Triggers a redraw so the visual updates immediately. */
  setLineStartOverride(lngLat) {
    this._lineStartOverride = (Array.isArray(lngLat) && lngLat.length >= 2) ? lngLat : null;
    if (this._map) {
      this._renderAimLine();
      this._updateFloatingDists();
    }
  }

  /* Mutate the existing aim-marker DOM element in place to reflect lock state.
     Red border + non-grab cursor when locked; white + grab when unlocked.
     Toggles draggability via MapLibre Marker.setDraggable when available. */
  _updateAimMarkerStyle() {
    if (!this._aimMarker) return;
    var locked = !!this._aimLocked;
    if (typeof this._aimMarker.setDraggable === 'function') {
      try { this._aimMarker.setDraggable(!locked); } catch(e) {}
    }
    var el = (typeof this._aimMarker.getElement === 'function')
      ? this._aimMarker.getElement() : null;
    if (el) {
      el.style.borderColor = locked ? '#ef4444' : '#ffffff';
      el.style.cursor      = locked ? 'default' : 'grab';
      /* Optional: subtle red glow when locked so the state is unmistakable. */
      el.style.boxShadow   = locked
        ? '0 0 8px rgba(239,68,68,.7)'
        : '0 0 6px rgba(0,0,0,.6)';
    }
  }

  /* Lazy source/layer creation for shot-dispersion overlay. Mirrors the
     mv-radials pattern. Two layers: intended (start->aim, green) and actual
     (start->end, red). pathKind: 'intended' | 'actual' filter on properties.kind. */
  _ensureDispersionLayer() {
    if (!this._map) return;
    try {
      if (!this._map.getSource('mv-dispersion')) {
        this._map.addSource('mv-dispersion', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!this._map.getLayer('mv-dispersion-intended')) {
        this._map.addLayer({
          id: 'mv-dispersion-intended',
          type: 'line',
          source: 'mv-dispersion',
          filter: ['==', ['get', 'kind'], 'intended'],
          paint: {
            'line-color': '#22c55e',
            'line-width': 2,
            'line-opacity': 0.85
          }
        });
      }
      if (!this._map.getLayer('mv-dispersion-actual')) {
        this._map.addLayer({
          id: 'mv-dispersion-actual',
          type: 'line',
          source: 'mv-dispersion',
          filter: ['==', ['get', 'kind'], 'actual'],
          paint: {
            'line-color': '#ef4444',
            'line-width': 2.5,
            'line-opacity': 0.9
          }
        });
      }
    } catch(e) {}
  }

  /* Render the just-completed shot's intended vs actual lines until the next
     shot is armed (or hole change / cancel). pts: { startLL, aimLL, endLL }. */
  setDispersionLines(pts) {
    if (!this._map || !pts) return;
    this._ensureDispersionLayer();
    var src;
    try { src = this._map.getSource('mv-dispersion'); } catch(e) { return; }
    if (!src) return;
    var feats = [];
    if (Array.isArray(pts.startLL) && Array.isArray(pts.aimLL)) {
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [pts.startLL, pts.aimLL] },
        properties: { kind: 'intended' }
      });
    }
    if (Array.isArray(pts.startLL) && Array.isArray(pts.endLL)) {
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [pts.startLL, pts.endLL] },
        properties: { kind: 'actual' }
      });
    }
    try { src.setData({ type: 'FeatureCollection', features: feats }); } catch(e) {}
  }

  /* Clear the dispersion overlay. Called from showHole, stCancel handler, and
     on next shot arm. */
  clearDispersionLines() {
    if (!this._map) return;
    var src;
    try { src = this._map.getSource('mv-dispersion'); } catch(e) { return; }
    if (!src) return;
    try { src.setData({ type: 'FeatureCollection', features: [] }); } catch(e) {}
  }
}
