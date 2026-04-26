/**
 * geomap.js - Map rendering, OSM golf-course discovery/load, geo helpers, GPS.
 *
 * Foundation module for Gordy's geomapping integration (G1).
 *
 * Depends on CDN globals (loaded by index.html):
 *   - window.maplibregl  (MapLibre GL JS 3.6.2)
 *   - window.turf        (Turf.js)
 *
 * All network calls use a 25s AbortController timeout and reject with
 * new Error('TIMEOUT') on expiry.
 *
 * Rendering contract:
 *   - Maps carry two GeoJSON sources: 'course-polygons' (golf=*) and
 *     'active-path' (current shot/path line).
 *   - Layer palette and opacity ported verbatim from the reference prototype.
 *
 * Module is idempotent where it matters: geomCreateMap on the same container
 * returns the existing Map instance rather than double-initialising.
 */

// -----------------------------------------------------------------------------
// Internal constants (ported from reference)
// -----------------------------------------------------------------------------

const GC = {
  fairway:      '#7ec850',
  green:        '#28a050',
  tee:          '#d0d8e0',
  bunker:       '#c9a84c',
  lateral_water_hazard: '#5b9bd5',
  rough:        '#4a7a28'
};

const NET_TIMEOUT_MS = 25000;

// Track Map instances by container element so geomCreateMap is idempotent.
const _mapRegistry = new WeakMap();

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * fetch wrapper with a 25s AbortController timeout.
 * Rejects with new Error('TIMEOUT') if the abort fires first.
 */
async function _fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
    return res;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape an Overpass element (node/way/relation with optional .center) into
 * our search-result format. elements here are the raw "out center" results.
 */
function _shapeSearchResult(e) {
  const lat = e.center ? e.center.lat : e.lat;
  const lon = e.center ? e.center.lon : e.lon;
  const name = (e.tags && e.tags.name) ? e.tags.name : 'Unnamed Course';
  return {
    name,
    center: [lon, lat],
    osmId: `${e.type}/${e.id}`,
    bounds: e.bounds || null
  };
}

// -----------------------------------------------------------------------------
// Map factory
// -----------------------------------------------------------------------------

/**
 * Create (or retrieve) a MapLibre map on `container` with the ESRI World
 * Imagery raster base, an empty course-polygons source + fill/line layers
 * for the six golf=* types, and an empty active-path source + line/arrow
 * layers. Ported from reference prototype lines 100-170.
 *
 * Idempotent: calling twice on the same container returns the existing map.
 *
 * @param {HTMLElement|string} container
 * @param {{center?:number[], zoom?:number, pitch?:number, dragRotate?:boolean}} [opts]
 * @returns {maplibregl.Map}
 */
export function geomCreateMap(container, opts) {
  const el = (typeof container === 'string') ? document.getElementById(container) : container;
  if (!el) throw new Error('geomCreateMap: container not found');

  const existing = _mapRegistry.get(el);
  if (existing) return existing;

  const o = opts || {};

  const map = new window.maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: {
        esri: {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256
        }
      },
      layers: [{ id: 'esri-imagery', type: 'raster', source: 'esri' }]
    },
    center:      o.center      || [-81.168, 43.034],
    zoom:        (o.zoom != null) ? o.zoom : 14,
    pitch:       (o.pitch != null) ? o.pitch : 0,
    dragRotate:  (o.dragRotate != null) ? o.dragRotate : true
  });

  map.on('load', () => {
    // Course polygons source + per-type fill & outline layers.
    map.addSource('course-polygons', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    for (const type of Object.keys(GC)) {
      map.addLayer({
        id: `poly-${type}`,
        type: 'fill',
        source: 'course-polygons',
        filter: ['==', 'golf', type],
        paint: { 'fill-color': GC[type], 'fill-opacity': 0.5 }
      });
      map.addLayer({
        id: `line-${type}`,
        type: 'line',
        source: 'course-polygons',
        filter: ['==', 'golf', type],
        paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.3 }
      });
    }

    // Active path source + dashed line + directional arrows.
    map.addSource('active-path', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
      id: 'path-line',
      type: 'line',
      source: 'active-path',
      paint: { 'line-color': '#f1c40f', 'line-width': 3, 'line-dasharray': [2, 2] }
    });

    map.addLayer({
      id: 'path-arrows',
      type: 'symbol',
      source: 'active-path',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 50,
        'text-field': '\u25B6',
        'text-size': 14,
        'text-keep-upright': false
      },
      paint: { 'text-color': '#f1c40f', 'text-halo-color': '#000', 'text-halo-width': 1 }
    });
  });

  _mapRegistry.set(el, map);
  return map;
}

// -----------------------------------------------------------------------------
// Discovery (Nominatim + Overpass)
// -----------------------------------------------------------------------------

/**
 * Geocode `city` via Nominatim, then search Overpass for leisure=golf_course
 * matching `courseName` (case-insensitive regex) within 50km of the city.
 *
 * Ports the reference locateCourse() flow but returns structured results
 * instead of mutating DOM.
 *
 * @param {string} city
 * @param {string} courseName
 * @returns {Promise<Array<{name:string, center:number[], osmId:string, bounds:any}>>}
 */
export async function geomSearchByName(city, courseName) {
  if (!city || !courseName) return [];

  /* ------------------------------------------------------------------ */
  /* Stage 1: Resolve city via Nominatim.                                */
  /* Fetch up to 5 results; prefer administrative boundary relations     */
  /* to get a real bounding box rather than a point result.             */
  /* No countrycodes filter — supports CA, US, and beyond.             */
  /* ------------------------------------------------------------------ */
  const geoUrl = 'https://nominatim.openstreetmap.org/search?format=json&q='
    + encodeURIComponent(city);
  const geoRes = await _fetchWithTimeout(geoUrl);
  if (!geoRes.ok) throw new Error('Nominatim HTTP ' + geoRes.status);
  const geoData = await geoRes.json();
  if (!geoData || !geoData.length) throw new Error('CITY_NOT_FOUND');

  /* Take Nominatim's top relevance result directly (matches osmtest). */
  const place = geoData[0];

  const cLat = parseFloat(place.lat);
  const cLon = parseFloat(place.lon);
  /* Sanitize for Overpass regex: strip all special ERE chars to avoid
     query rejection. Better to search a simplified name than crash. */
  const safeName = courseName.replace(/[.^$*+?{}[\]|()\\"/]/g, ' ').trim();

  /* ------------------------------------------------------------------ */
  /* Stage 2: Build search bbox from Nominatim boundingbox.             */
  /* ------------------------------------------------------------------ */
  var overpassBbox;
  if (place.boundingbox && place.boundingbox.length === 4) {
    /* Nominatim: [s, n, w, e] — reorder to Overpass: s, w, n, e */
    var s = parseFloat(place.boundingbox[0]);
    var n = parseFloat(place.boundingbox[1]);
    var w = parseFloat(place.boundingbox[2]);
    var e = parseFloat(place.boundingbox[3]);
    /* Sanity-expand tiny bbox (point results) by ~5km (~0.045 deg) */
    if ((n - s) < 0.05) { s -= 0.045; n += 0.045; }
    if ((e - w) < 0.05) { w -= 0.065; e += 0.065; }
    overpassBbox = s + ',' + w + ',' + n + ',' + e;
  } else {
    overpassBbox = (cLat - 0.09) + ',' + (cLon - 0.13) + ',' + (cLat + 0.09) + ',' + (cLon + 0.13);
  }

  /* ------------------------------------------------------------------ */
  /* Stage 3: Overpass — three attempts, all bbox-based.                */
  /* A: exact name. B: regex. C: all courses in city (name-free).       */
  /* ------------------------------------------------------------------ */
  var elements = null;

  /* Attempt A: exact name match inside bbox */
  if (safeName) {
    try {
      const qA =
        '[out:json][timeout:20];\n' +
        '(\n' +
        '  nwr["leisure"="golf_course"]["name"="' + safeName + '"](' + overpassBbox + ');\n' +
        ');\n' +
        'out center;';
      const resA = await _fetchWithTimeout(
        'https://overpass-api.de/api/interpreter',
        { method: 'POST', body: qA }
      );
      if (resA.ok) {
        const dataA = await resA.json();
        if (dataA.elements && dataA.elements.length) elements = dataA.elements;
      }
    } catch(e) { if (e && e.message === 'TIMEOUT') throw e; }
  }

  /* Attempt B: case-insensitive regex inside bbox */
  if (!elements && safeName) {
    try {
      const qB =
        '[out:json][timeout:20];\n' +
        '(\n' +
        '  nwr["leisure"="golf_course"]["name"~"' + safeName + '",i](' + overpassBbox + ');\n' +
        ');\n' +
        'out center;';
      const resB = await _fetchWithTimeout(
        'https://overpass-api.de/api/interpreter',
        { method: 'POST', body: qB }
      );
      if (resB.ok) {
        const dataB = await resB.json();
        if (dataB.elements && dataB.elements.length) elements = dataB.elements;
      }
    } catch(e) { if (e && e.message === 'TIMEOUT') throw e; }
  }

  /* Attempt C: all leisure=golf_course in bbox, no name filter.
     User picks from the list — better than returning nothing. */
  if (!elements) {
    try {
      const qC =
        '[out:json][timeout:20];\n' +
        '(\n' +
        '  nwr["leisure"="golf_course"](' + overpassBbox + ');\n' +
        ');\n' +
        'out center;';
      const resC = await _fetchWithTimeout(
        'https://overpass-api.de/api/interpreter',
        { method: 'POST', body: qC }
      );
      if (resC.ok) {
        const dataC = await resC.json();
        if (dataC.elements && dataC.elements.length) elements = dataC.elements;
      }
    } catch(e) { if (e && e.message === 'TIMEOUT') throw e; }
  }

  if (!elements || !elements.length) return [];

  /* Sort by distance to city center */
  const cityPt = window.turf.point([cLon, cLat]);
  const results = elements.map(_shapeSearchResult);
  results.sort(function(a, b) {
    const da = window.turf.distance(cityPt, window.turf.point(a.center), { units: 'meters' });
    const db = window.turf.distance(cityPt, window.turf.point(b.center), { units: 'meters' });
    return da - db;
  });
  return results;
}

/**
 * Overpass search for leisure=golf_course within a lon/lat bounding box.
 * Ports reference searchHere() flow.
 *
 * @param {number[]} bbox [sw_lon, sw_lat, ne_lon, ne_lat]
 * @returns {Promise<Array<{name:string, center:number[], osmId:string, bounds:any}>>}
 */
export async function geomSearchByBounds(bbox) {
  if (!bbox || bbox.length !== 4) return [];
  const [swLon, swLat, neLon, neLat] = bbox;

  const q =
    '[out:json][timeout:15];\n' +
    `( nwr["leisure"="golf_course"](${swLat},${swLon},${neLat},${neLon}); ); out center;`;

  const res = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: q }
  );
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  if (!data.elements || !data.elements.length) return [];
  return data.elements.map(_shapeSearchResult);
}

/**
 * Convenience wrapper: Overpass search for leisure=golf_course around a
 * lon/lat point, sorted by distance ascending.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} [radiusM=10000]
 * @returns {Promise<Array<{name:string, center:number[], osmId:string, bounds:any}>>}
 */
export async function geomSearchByLocation(lon, lat, radiusM) {
  const r = (radiusM != null) ? radiusM : 10000;

  const q =
    '[out:json][timeout:15];\n' +
    `( nwr["leisure"="golf_course"](around:${r}, ${lat}, ${lon}); ); out center;`;

  const res = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: q }
  );
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  if (!data.elements || !data.elements.length) return [];

  const origin = window.turf.point([lon, lat]);
  const results = data.elements.map(_shapeSearchResult);
  results.sort((a, b) => {
    const da = window.turf.distance(origin, window.turf.point(a.center), { units: 'meters' });
    const db = window.turf.distance(origin, window.turf.point(b.center), { units: 'meters' });
    return da - db;
  });
  return results;
}

// -----------------------------------------------------------------------------
// Geometry load (Overpass golf=* + processOSM port)
// -----------------------------------------------------------------------------

/**
 * Port of reference processOSM (geomapping.html ~329-388), refactored as a
 * pure function: takes raw Overpass elements, returns structured result.
 *
 * Grouping contract:
 *   - Key:  `${track}_${ref}` where track = tags.course || 'Main'.
 *   - golf=tee    -> assigns tee point (first coord) to hole.
 *   - golf=green  -> assigns turf.center centroid to hole.
 *   - golf=hole   -> assigns centreline coords array to hole.
 *   - Polygon closure: ways other than golf=hole are closed (last==first) and
 *     included in the FeatureCollection if they have >=4 points.
 *   - Holes missing tee/green: derive from centreline ends, search unreffed
 *     greens within 50m of centreline end.
 */
function _processOSM(elements) {
  const courseHoles = {};
  const nodes = {};
  const geoFeatures = [];
  const rawFeatures = [];

  elements.forEach(e => {
    if (e.type === 'node') nodes[e.id] = [e.lon, e.lat];
  });

  elements.forEach(e => {
    if (!e.tags) return;
    /* G2b -- water bodies lack golf= tag; promote to water_hazard for rendering */
    if (!e.tags.golf && (e.tags.natural === 'water' || e.tags.landuse === 'reservoir' || e.tags.golf === 'lateral_water_hazard')) {
      e.tags.golf = 'lateral_water_hazard';
    }
    if (!e.tags.golf) return;
    let coords = [];
    if (e.type === 'way' && e.nodes) {
      coords = e.nodes.map(id => nodes[id]).filter(Boolean);
    } else if (e.type === 'node') {
      coords = [nodes[e.id]];
    }
    if (!coords.length) return;

    rawFeatures.push({
      type: e.tags.golf,
      coords: coords,
      ref: e.tags.ref,
      course: e.tags.course || 'Main'
    });

    if (e.type === 'way') {
      if (e.tags.golf !== 'hole') {
        // Close polygon if not already closed.
        const polyCoords = coords.slice();
        const first = polyCoords[0];
        const last = polyCoords[polyCoords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          polyCoords.push(first);
        }
        // Turf requires >=4 points for a closed polygon.
        if (polyCoords.length >= 4) {
          geoFeatures.push(window.turf.polygon([polyCoords], { golf: e.tags.golf }));
        }
      }
    }

    const ref = e.tags.ref;
    if (ref) {
      const track = e.tags.course || 'Main';
      const key = `${track}_${ref}`;
      if (!courseHoles[key]) courseHoles[key] = { track, ref };
      if (e.tags.golf === 'tee')   courseHoles[key].tee   = coords[0];
      if (e.tags.golf === 'green') {
        courseHoles[key].green = window.turf.center(window.turf.points(coords)).geometry.coordinates;
      }
      if (e.tags.golf === 'hole')  courseHoles[key].line  = coords;
    }
  });

  // Derive missing tee/green from centrelines + unreffed greens within 50m.
  const unreffedGreens = rawFeatures.filter(f => f.type === 'green' && !f.ref);
  Object.keys(courseHoles).forEach(key => {
    const h = courseHoles[key];
    if (h.line) {
      if (!h.tee) h.tee = h.line[0];
      if (!h.green) {
        const endCoord = h.line[h.line.length - 1];
        const endPt = window.turf.point(endCoord);
        let closest = endCoord;
        let minDist = 50;
        unreffedGreens.forEach(g => {
          const center = window.turf.center(window.turf.points(g.coords)).geometry.coordinates;
          const dist = window.turf.distance(endPt, window.turf.point(center), { units: 'meters' });
          if (dist < minDist) { minDist = dist; closest = center; }
        });
        h.green = closest;
      }
    }
  });

  // Compute per-hole bounds (bbox of tee+green+line).
  Object.keys(courseHoles).forEach(key => {
    const h = courseHoles[key];
    const pts = [];
    if (h.tee)   pts.push(h.tee);
    if (h.green) pts.push(h.green);
    if (h.line)  for (const p of h.line) pts.push(p);
    if (pts.length) {
      const fc = window.turf.featureCollection(pts.map(p => window.turf.point(p)));
      h.bounds = window.turf.bbox(fc); // [minX, minY, maxX, maxY]
    }
  });

  const polygons = window.turf.featureCollection(geoFeatures);

  return { holes: courseHoles, polygons, rawFeatures };
}

/**
 * Load course geometry within `radiusM` of (lon, lat) via Overpass, then
 * run processOSM on the response.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} [radiusM=1500]
 * @returns {Promise<{holes:object, polygons:object, center:number[], bounds:number[][]}>}
 */
export async function geomLoadByCenter(lon, lat, radiusM) {
  const r = (radiusM != null) ? radiusM : 1500;

  const q =
    '[out:json][timeout:25];\n' +
    '(\n' +
    `  way["golf"](around:${r}, ${lat}, ${lon});\n` +
    `  node["golf"](around:${r}, ${lat}, ${lon});\n` +
    `  relation["type"="golf_hole"](around:${r}, ${lat}, ${lon});\n` +
    /* G2b -- water bodies on golf courses are tagged natural=water/landuse=reservoir, not golf=water_hazard */
    `  way["natural"="water"](around:${r}, ${lat}, ${lon});\n` +
    `  way["landuse"="reservoir"](around:${r}, ${lat}, ${lon});\n` +
    `  way["golf"="lateral_water_hazard"](around:${r}, ${lat}, ${lon});\n` +
    '); out body; >; out skel qt;';

  const res = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: q }
  );
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  const elements = (data && data.elements) || [];

  const processed = _processOSM(elements);

  // Overall bounds across all polygons.
  let bounds = null;
  if (processed.polygons.features.length) {
    const bb = window.turf.bbox(processed.polygons); // [minX, minY, maxX, maxY]
    bounds = [[bb[0], bb[1]], [bb[2], bb[3]]];
  }

  return {
    holes: processed.holes,
    polygons: processed.polygons,
    center: [lon, lat],
    bounds
  };
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/**
 * Write geo.polygons into the map's `course-polygons` source and fit the
 * viewport to geo.bounds (if present).
 *
 * @param {maplibregl.Map} map
 * @param {{polygons:object, bounds:number[][]|null}} geo
 */
export function geomRenderGeometry(map, geo) {
  if (!map || !geo) return;
  const apply = () => {
    const src = map.getSource('course-polygons');
    if (src) src.setData(geo.polygons);
    if (geo.bounds) {
      map.fitBounds(geo.bounds, { padding: 40, duration: 0 });
    }
  };
  if (map.isStyleLoaded && map.isStyleLoaded()) apply();
  else map.once('load', apply);
}

/**
 * Fly to a specific hole with the camera bearing set tee -> green.
 *
 * @param {maplibregl.Map} map
 * @param {{holes:object}} geo
 * @param {string|number} holeN
 * @returns {object|null} the matched hole object, or null
 */
export function geomShowHole(map, geo, holeN) {
  if (!map || !geo || !geo.holes) return null;
  const want = String(holeN);
  let matched = null;
  for (const key of Object.keys(geo.holes)) {
    if (String(geo.holes[key].ref) === want) { matched = geo.holes[key]; break; }
  }
  if (!matched || !matched.tee || !matched.green) return matched || null;

  const brg = window.turf.bearing(
    window.turf.point(matched.tee),
    window.turf.point(matched.green)
  );
  map.flyTo({ center: matched.tee, zoom: 17.5, bearing: brg, pitch: 0 });
  return matched;
}

/**
 * Update the `active-path` source with a LineString built from `points`.
 * Passing an empty array clears the path.
 *
 * @param {maplibregl.Map} map
 * @param {Array<number[]>} points
 */
export function geomRenderPath(map, points) {
  if (!map) return;
  const src = map.getSource('active-path');
  if (!src) return;
  if (!points || points.length < 2) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  src.setData(window.turf.featureCollection([window.turf.lineString(points)]));
}

// -----------------------------------------------------------------------------
// Geo helpers (Turf wrappers)
// -----------------------------------------------------------------------------

/**
 * Great-circle distance in yards, rounded to integer.
 * @param {number[]} a [lon, lat]
 * @param {number[]} b [lon, lat]
 */
export function geomDistanceYds(a, b) {
  return Math.round(window.turf.distance(
    window.turf.point(a),
    window.turf.point(b),
    { units: 'yards' }
  ));
}

/**
 * Initial bearing from a to b, normalised to 0-360.
 * @param {number[]} a [lon, lat]
 * @param {number[]} b [lon, lat]
 */
export function geomBearingDeg(a, b) {
  const raw = window.turf.bearing(window.turf.point(a), window.turf.point(b));
  return ((raw % 360) + 360) % 360;
}

/**
 * Test whether a lon/lat lies inside a polygon feature.
 * @param {number[]} lngLat [lon, lat]
 * @param {object} polygon GeoJSON Polygon/MultiPolygon feature
 */
export function geomPointInPolygon(lngLat, polygon) {
  return window.turf.booleanPointInPolygon(window.turf.point(lngLat), polygon);
}

/**
 * Determine the lie at `lngLat` by testing each polygon in `polygons.features`.
 * Priority when multiple match:
 *   green > tee > fairway > rough > bunker > water_hazard
 * Returns the matching `properties.golf` value, or null.
 */
export function geomLieAtPoint(lngLat, polygons) {
  if (!polygons || !polygons.features || !polygons.features.length) return null;
  const pt = window.turf.point(lngLat);
  const priority = ['green', 'tee', 'fairway', 'rough', 'bunker', 'lateral_water_hazard'];
  const hits = new Set();
  for (const f of polygons.features) {
    if (!f || !f.properties || !f.properties.golf) continue;
    if (window.turf.booleanPointInPolygon(pt, f)) hits.add(f.properties.golf);
  }
  if (!hits.size) return null;
  for (const p of priority) if (hits.has(p)) return p;
  return hits.values().next().value;
}

// -----------------------------------------------------------------------------
// GPS
// -----------------------------------------------------------------------------

/**
 * Start a high-accuracy geolocation watch.
 * onTick receives [lon, lat, accuracy]. onError receives the raw error.
 *
 * @param {(tick:number[])=>void} onTick
 * @param {(err:any)=>void} [onError]
 * @returns {number} watchId
 */
export function geomStartGpsWatch(onTick, onError) {
  if (!('geolocation' in navigator)) {
    if (onError) onError(new Error('Geolocation unavailable'));
    return -1;
  }
  return navigator.geolocation.watchPosition(
    (pos) => {
      onTick([pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy]);
    },
    (err) => { if (onError) onError(err); },
    { enableHighAccuracy: true }
  );
}

/**
 * Stop a watch started by geomStartGpsWatch.
 * @param {number} watchId
 */
export function geomStopGpsWatch(watchId) {
  if (watchId != null && watchId >= 0 && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(watchId);
  }
}

/**
 * One-shot high-accuracy position.
 * @returns {Promise<number[]>} [lon, lat, accuracy]
 */
export function geomGetCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude, pos.coords.accuracy]),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: NET_TIMEOUT_MS }
    );
  });
}

// -----------------------------------------------------------------------------
// G3-FIX -- Course-bounded geometry fetch
// -----------------------------------------------------------------------------

/**
 * Load course geometry bounded to a specific OSM course element, eliminating
 * bleed from adjacent courses. Falls back to geomLoadByCenter if the course
 * boundary cannot be resolved.
 *
 * Path B (relation): fetch relation members tagged golf=* directly.
 * Path A (bbox + containment): fetch course boundary, then all golf=* in bbox,
 *   filter by centroid-inside-boundary. Most reliable path.
 *
 * Returns same shape as geomLoadByCenter, plus a `boundary` field for G3.
 *
 * @param {string} osmCourseId  e.g. "relation/12345" or "way/67890"
 * @param {number[]|null} fallbackCenter  [lon, lat] for geomLoadByCenter fallback
 * @returns {Promise<{holes, polygons, center, bounds, boundary?}>}
 */
export async function geomLoadByCourse(osmCourseId, fallbackCenter) {
  if (!osmCourseId) throw new Error('geomLoadByCourse: osmCourseId required');

  /* Parse type/id from string like "relation/12345" or "way/67890" */
  var parts = String(osmCourseId).split('/');
  var osmType = parts[0]; /* "relation" | "way" */
  var osmId   = parts[1];
  if (!osmId) throw new Error('geomLoadByCourse: invalid osmCourseId format');

  /* ------------------------------------------------------------------ */
  /* Path B: relation members (fast path, only works for relations with  */
  /* golf=* members)                                                     */
  /* ------------------------------------------------------------------ */
  if (osmType === 'relation') {
    try {
      var qB =
        '[out:json][timeout:15];\n' +
        '(relation(' + osmId + ');\n' +
        ' way(r); node(w););\n' +
        'out body geom;';
      var resB = await _fetchWithTimeout(
        'https://overpass-api.de/api/interpreter',
        { method: 'POST', body: qB }
      );
      if (resB.ok) {
        var dataB = await resB.json();
        var elemsB = (dataB && dataB.elements) || [];
        var hasGolf = elemsB.some(function(e) { return e.tags && e.tags.golf; });
        if (hasGolf) {
          var procB = _processOSM(elemsB);
          var boundsB = null;
          if (procB.polygons.features.length) {
            var bbB = window.turf.bbox(procB.polygons);
            boundsB = [[bbB[0], bbB[1]], [bbB[2], bbB[3]]];
          }
          var centerB = fallbackCenter || (boundsB
            ? [(boundsB[0][0] + boundsB[1][0]) / 2, (boundsB[0][1] + boundsB[1][1]) / 2]
            : [0, 0]);
          return { holes: procB.holes, polygons: procB.polygons, center: centerB, bounds: boundsB };
        }
        /* No golf=* members — fall through to Path A */
      }
    } catch (e) {
      if (e && e.message === 'TIMEOUT') throw e;
      /* Non-fatal: fall through to Path A */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Path A: fetch course boundary, bbox query, centroid containment     */
  /* ------------------------------------------------------------------ */

  /* Step 1: fetch the course element itself with full geometry */
  var qBoundary =
    '[out:json][timeout:15];\n' +
    '(way(' + osmId + '); relation(' + osmId + '););\n' +
    'out body geom;';
  var resBoundary = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: qBoundary }
  );
  if (!resBoundary.ok) throw new Error('Overpass HTTP ' + resBoundary.status);
  var dataBoundary = await resBoundary.json();
  var boundaryElems = (dataBoundary && dataBoundary.elements) || [];

  /* Step 2: build boundary polygon from the course element */
  var boundary = null;
  for (var bi = 0; bi < boundaryElems.length; bi++) {
    var be = boundaryElems[bi];
    if (!be) continue;
    if (be.type === 'way' && be.geometry && be.geometry.length >= 4) {
      var wCoords = be.geometry.map(function(n) { return [n.lon, n.lat]; });
      /* Ensure ring is closed */
      if (wCoords[0][0] !== wCoords[wCoords.length - 1][0] ||
          wCoords[0][1] !== wCoords[wCoords.length - 1][1]) {
        wCoords.push(wCoords[0]);
      }
      if (wCoords.length >= 4) {
        try { boundary = window.turf.polygon([wCoords]); break; } catch(e) {}
      }
    } else if (be.type === 'relation' && be.members) {
      /* Relation: pick the longest outer way as boundary ring.
         Rationale: merging multiple outer ways requires ring-stitching which
         is error-prone on mobile. Longest outer way covers most of the course
         area in practice. */
      var bestLen = 0;
      var bestCoords = null;
      for (var mi = 0; mi < be.members.length; mi++) {
        var mem = be.members[mi];
        if (mem && mem.role === 'outer' && mem.geometry && mem.geometry.length >= 4) {
          if (mem.geometry.length > bestLen) {
            bestLen = mem.geometry.length;
            bestCoords = mem.geometry.map(function(n) { return [n.lon, n.lat]; });
          }
        }
      }
      if (bestCoords && bestCoords.length >= 4) {
        if (bestCoords[0][0] !== bestCoords[bestCoords.length - 1][0] ||
            bestCoords[0][1] !== bestCoords[bestCoords.length - 1][1]) {
          bestCoords.push(bestCoords[0]);
        }
        try { boundary = window.turf.polygon([bestCoords]); break; } catch(e) {}
      }
    }
  }

  if (!boundary) throw new Error('NO_COURSE_BOUNDARY');

  /* Step 3: compute bbox [south, west, north, east] — Overpass order */
  var bb = window.turf.bbox(boundary); /* [minX=west, minY=south, maxX=east, maxY=north] */
  var overpassBbox = bb[1] + ',' + bb[0] + ',' + bb[3] + ',' + bb[2]; /* south,west,north,east */

  /* Step 4: fetch all golf=* inside bbox */
  var qGolf =
    '[out:json][timeout:15];\n' +
    '(\n' +
    '  way["golf"](' + overpassBbox + ');\n' +
    '  relation["type"="golf_hole"](' + overpassBbox + ');\n' +
    '  node["golf"](' + overpassBbox + ');\n' +
    '  way["natural"="water"](' + overpassBbox + ');\n' +
    '  way["landuse"="reservoir"](' + overpassBbox + ');\n' +
    '  way["golf"="lateral_water_hazard"](' + overpassBbox + ');\n' +
    ');\n' +
    'out body; >; out skel qt;';
  var resGolf = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: qGolf }
  );
  if (!resGolf.ok) throw new Error('Overpass HTTP ' + resGolf.status);
  var dataGolf = await resGolf.json();
  var elemsGolf = (dataGolf && dataGolf.elements) || [];

  /* Step 5: processOSM on raw elements */
  var processed = _processOSM(elemsGolf);

  /* Step 6: centroid containment filter — drop polygons whose centroid falls
     outside the course boundary. Handles adjacent-course bleed. */
  var filtered = processed.polygons.features.filter(function(f) {
    try {
      var c = window.turf.centroid(f);
      return window.turf.booleanPointInPolygon(c, boundary);
    } catch(e) { return true; /* keep on error */ }
  });
  var filteredFC = window.turf.featureCollection(filtered);

  /* Step 7: holes passed through unfiltered. OSM course boundaries are often loosely
     drawn and tee boxes frequently sit just outside the leisure=golf_course polygon.
     The polygon centroid filter (Step 6) is sufficient to prevent adjacent-course bleed;
     a second containment pass on tee/green coords drops legitimate holes on imprecise
     boundaries. */
  var filteredHoles = processed.holes;

  /* Step 8: compute overall bounds from filtered polygons */
  var bounds = null;
  if (filteredFC.features.length) {
    var bbF = window.turf.bbox(filteredFC);
    bounds = [[bbF[0], bbF[1]], [bbF[2], bbF[3]]];
  }

  /* Derive center from boundary centroid */
  var centerCoords = window.turf.centroid(boundary).geometry.coordinates;

  return {
    holes:    filteredHoles,
    polygons: filteredFC,
    center:   centerCoords,
    bounds:   bounds,
    boundary: boundary   /* G3 will consume for viz overlay clipping */
  };
}



/* ============================================================================
   G4 -- City geocoding only (no Overpass). Used by unified locate-modal flow.
   Mirrors the osmtest pattern: simple Nominatim query, take top result.
   Returns { center:[lon,lat], bounds:[s,w,n,e]|null, displayName }.
   Throws Error('CITY_NOT_FOUND') on empty response.
   ============================================================================ */
export async function geomGeocodeCity(city) {
  if (!city || !String(city).trim()) throw new Error('CITY_REQUIRED');
  const url = 'https://nominatim.openstreetmap.org/search?format=json&q='
    + encodeURIComponent(city);
  const res = await _fetchWithTimeout(url);
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.length) throw new Error('CITY_NOT_FOUND');
  const p = data[0];
  let bounds = null;
  if (p.boundingbox && p.boundingbox.length === 4) {
    /* Nominatim bbox: [s, n, w, e] -> normalize to [s, w, n, e] */
    bounds = [parseFloat(p.boundingbox[0]), parseFloat(p.boundingbox[2]),
              parseFloat(p.boundingbox[1]), parseFloat(p.boundingbox[3])];
  }
  return {
    center: [parseFloat(p.lon), parseFloat(p.lat)],
    bounds: bounds,
    displayName: p.display_name || ''
  };
}

/* ============================================================================
   G5 -- Unified locate-course modal. Single source of truth for both the
   live-round entry flow and the courses-tab geotag flow.

   Contract:
     geomOpenLocateModal({
       course,                    // {id, name, city, osmCenter?}
       onSelect,                  // (osmId, center) => void  -- user picked a course
       onSkip                     // optional () => void      -- user skipped
     })

   Behavior:
     - Pinned course (course.osmCenter present): map opens at osmCenter zoom 15,
       crosshair shown, no city bar. User pans/GPS -> Search here -> picker.
     - Unpinned course: city bar shown, map mounts on city resolve OR GPS use,
       crosshair revealed, yellow marker dropped on resolved city, user pans/GPS
       -> Search here -> picker.
     - Picker: 1 result auto-selects (calls onSelect). >1 shows clickable list.
     - Skip / X: closes overlay, calls onSkip if provided.

   Module-level state below is reset by _geomLocateClose. Single-instance only:
   opening a second modal while one is live closes the first.
   ============================================================================ */
var _geomLocateMap        = null;
var _geomLocateCityMarker = null;
var _geomLocateResults    = [];
var _geomLocateCallbacks  = null;  /* { onSelect, onSkip } */

export function geomOpenLocateModal(opts) {
  opts = opts || {};
  /* Defensive: close any prior instance before opening a new one */
  _geomLocateClose(true);
  _geomLocateCallbacks = { onSelect: opts.onSelect || null, onSkip: opts.onSkip || null };

  const course = opts.course || null;
  const pinned = !!(course && course.osmCenter && course.osmCenter.length === 2
    && isFinite(course.osmCenter[0]) && isFinite(course.osmCenter[1]));
  const start = pinned ? [course.osmCenter[0], course.osmCenter[1]] : null;
  const defaultCity = (course && course.city) ? String(course.city).replace(/"/g, '&quot;') : '';
  const courseName = (course && course.name) ? String(course.name).replace(/</g, '&lt;') : '';

  const cityBarHtml = pinned ? '' :
      '<div style="padding:8px 12px;border-bottom:1px solid var(--br);'
    +   'display:flex;gap:6px;align-items:center;background:var(--bg2,#1a1a1a)">'
    +   '<input id="geomLocCityInput" type="text" value="' + defaultCity + '" '
    +     'placeholder="City (e.g. Verona, NY)" '
    +     'style="flex:1;background:var(--bg);border:1px solid var(--br);border-radius:4px;'
    +     'color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.7rem;'
    +     'padding:5px 8px;outline:none">'
    +   '<button class="btn" style="font-size:.65rem;padding:5px 12px" '
    +     'onclick="_geomLocateCitySearch()">Find city</button>'
    + '</div>';

  const headerSubtitle = pinned
    ? 'Pan the map or use GPS, then tap Load course here.'
    : 'Find your city, then pan the crosshair to your course.';
  const headerTitle = courseName ? ('Locate: ' + courseName) : 'Locate course';

  const overlay = document.createElement('div');
  overlay.id = 'geomLocateOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg);'
    + 'display:flex;flex-direction:column;font-family:\'DM Mono\',monospace';
  overlay.innerHTML =
      '<div style="padding:10px 12px;border-bottom:1px solid var(--br);display:flex;'
    +   'justify-content:space-between;align-items:center;gap:10px">'
    +   '<div>'
    +     '<div style="font-size:.82rem;color:var(--tx);font-weight:600">' + headerTitle + '</div>'
    +     '<div style="font-size:.58rem;color:var(--tx3);margin-top:2px">' + headerSubtitle + '</div>'
    +   '</div>'
    +   '<button class="btn sec" style="font-size:.65rem;padding:5px 12px" '
    +     'onclick="_geomLocateSkip()">Skip</button>'
    + '</div>'
    + cityBarHtml
    + '<div id="geomLocCanvas" style="flex:1;min-height:0;background:#111;position:relative">'
    +   '<div id="geomLocCrosshair" style="position:absolute;left:50%;top:50%;'
    +     'width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;z-index:10;'
    +     'border:2px solid #f1c40f;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.35);'
    +     (pinned ? '' : 'display:none') + '"></div>'
    +   '<div id="geomLocStatus" style="position:absolute;left:10px;right:10px;top:10px;'
    +     'z-index:11;padding:8px 10px;background:rgba(0,0,0,.55);border-radius:6px;'
    +     'color:#fff;font-size:.62rem;display:none"></div>'
    +   (pinned ? '' :
        '<div id="geomLocEmptyHint" style="position:absolute;inset:0;display:flex;'
      +   'align-items:center;justify-content:center;color:var(--tx3);font-size:.7rem;'
      +   'text-align:center;padding:20px">Enter a city above to begin.</div>')
    + '</div>'
    + '<div style="padding:10px 12px;border-top:1px solid var(--br);display:flex;gap:8px">'
    +   '<button class="btn" style="flex:1;font-size:.68rem;padding:9px 10px" '
    +     'onclick="_geomLocatePanLoad()">\uD83D\uDCCD Load course here</button>'
    +   '<button class="btn sec" style="flex:1;font-size:.68rem;padding:9px 10px" '
    +     'onclick="_geomLocateGpsLoad()">\uD83D\uDCE1 Use my GPS</button>'
    + '</div>';
  document.body.appendChild(overlay);

  if (pinned) {
    setTimeout(function(){
      try {
        const el = document.getElementById('geomLocCanvas');
        if (!el) return;
        _geomLocateMap = geomCreateMap(el, { center: start, zoom: 15 });
      } catch(e) {
        _geomLocateSetStatus('Map failed to initialise: ' + (e && e.message ? e.message : 'unknown'), true);
      }
    }, 0);
  } else {
    setTimeout(function(){
      const inp = document.getElementById('geomLocCityInput');
      if (inp) inp.focus();
    }, 50);
  }
}

function _geomLocateSetStatus(msg, isErr) {
  const el = document.getElementById('geomLocStatus');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.style.background = isErr ? 'rgba(180,40,40,.75)' : 'rgba(0,0,0,.55)';
  el.textContent = msg;
}

function _geomLocateClose(silent) {
  const o = document.getElementById('geomLocateOverlay');
  if (o) o.remove();
  if (_geomLocateMap) { try { _geomLocateMap.remove(); } catch(e) {} _geomLocateMap = null; }
  if (_geomLocateCityMarker) { try { _geomLocateCityMarker.remove(); } catch(e) {} _geomLocateCityMarker = null; }
  _geomLocateResults = [];
  if (!silent && _geomLocateCallbacks && _geomLocateCallbacks.onSkip) {
    try { _geomLocateCallbacks.onSkip(); } catch(e) {}
  }
  if (!silent) _geomLocateCallbacks = null;
}

function _geomLocateSkip() {
  _geomLocateClose(false);
}

async function _geomLocateCitySearch() {
  const inp = document.getElementById('geomLocCityInput');
  const city = inp ? inp.value.trim() : '';
  if (!city) { _geomLocateSetStatus('Enter a city first.', true); return; }
  _geomLocateSetStatus('Searching\u2026', false);
  try {
    const geo = await geomGeocodeCity(city);
    const center = geo.center;
    const hint = document.getElementById('geomLocEmptyHint');
    if (hint) hint.style.display = 'none';
    const ch = document.getElementById('geomLocCrosshair');
    if (ch) ch.style.display = '';
    if (!_geomLocateMap) {
      const el = document.getElementById('geomLocCanvas');
      if (!el) { _geomLocateSetStatus('Map container missing.', true); return; }
      try { _geomLocateMap = geomCreateMap(el, { center: center, zoom: 13 }); }
      catch(e) {
        _geomLocateSetStatus('Map failed to initialise: ' + (e && e.message ? e.message : 'unknown'), true);
        return;
      }
      _geomLocateMap.once('load', function(){ _geomLocatePostCityMount(center, geo.bounds); });
    } else {
      _geomLocatePostCityMount(center, geo.bounds);
    }
    _geomLocateSetStatus('Pan crosshair to course, then tap "Load course here".', false);
  } catch (err) {
    const msg = err && err.message ? err.message : 'unknown';
    if (msg === 'CITY_NOT_FOUND') {
      _geomLocateSetStatus('City not found. Try adding state/province (e.g. "Verona, NY").', true);
    } else if (msg === 'CITY_REQUIRED') {
      _geomLocateSetStatus('Enter a city first.', true);
    } else {
      _geomLocateSetStatus('City search failed: ' + msg, true);
    }
  }
}

function _geomLocatePostCityMount(center, bounds) {
  if (!_geomLocateMap || !window.maplibregl) return;
  if (_geomLocateCityMarker) {
    try { _geomLocateCityMarker.setLngLat(center); } catch(e) {}
  } else {
    try {
      _geomLocateCityMarker = new window.maplibregl.Marker({ color: '#f1c40f' })
        .setLngLat(center).addTo(_geomLocateMap);
    } catch(e) { _geomLocateCityMarker = null; }
  }
  if (bounds) {
    try {
      _geomLocateMap.fitBounds(
        [[bounds[1], bounds[0]], [bounds[3], bounds[2]]],
        { padding: 30, maxZoom: 14, duration: 600 }
      );
    } catch(e) {}
  } else {
    try { _geomLocateMap.flyTo({ center: center, zoom: 13 }); } catch(e) {}
  }
}

async function _geomLocatePanLoad() {
  if (!_geomLocateMap) {
    _geomLocateSetStatus('Find a city first, then pan the crosshair to your course.', true);
    return;
  }
  const c = _geomLocateMap.getCenter();
  await _geomLocateSearchAndPick(c.lng, c.lat);
}

async function _geomLocateGpsLoad() {
  _geomLocateSetStatus('Getting GPS fix\u2026', false);
  try {
    const pos = await geomGetCurrentPosition();  /* [lon, lat, accuracy] */
    if (!_geomLocateMap) {
      const el = document.getElementById('geomLocCanvas');
      const hint = document.getElementById('geomLocEmptyHint');
      if (hint) hint.style.display = 'none';
      const ch = document.getElementById('geomLocCrosshair');
      if (ch) ch.style.display = '';
      if (el) {
        try { _geomLocateMap = geomCreateMap(el, { center: [pos[0], pos[1]], zoom: 16 }); }
        catch(e) {
          _geomLocateSetStatus('Map failed to initialise: ' + (e && e.message ? e.message : 'unknown'), true);
          return;
        }
      }
    } else {
      _geomLocateMap.flyTo({ center: [pos[0], pos[1]], zoom: 16 });
    }
    await _geomLocateSearchAndPick(pos[0], pos[1]);
  } catch (err) {
    _geomLocateSetStatus('GPS failed: ' + (err && err.message ? err.message : 'unknown') + '. Pan the map and try again.', true);
  }
}

async function _geomLocateSearchAndPick(lon, lat) {
  _geomLocateSetStatus('Searching for courses\u2026', false);
  try {
    const results = await geomSearchByLocation(lon, lat, 2500);
    if (!results || !results.length) {
      _geomLocateSetStatus('No golf courses found within 2500m. Pan closer or try GPS.', true);
      return;
    }
    if (results.length === 1) {
      _geomLocateInvokeSelect(results[0].osmId, results[0].center);
      return;
    }
    _geomLocateResults = results;
    _geomLocateSetStatus('', false);
    const el = document.getElementById('geomLocStatus');
    if (el) {
      el.style.display = 'block';
      el.style.background = 'rgba(0,0,0,.72)';
      el.innerHTML =
        '<div style="font-size:.62rem;color:#fff;margin-bottom:6px">Multiple courses found \u2014 select one:</div>'
        + results.map(function(r, i) {
          return '<button onclick="_geomLocatePickCourse(' + i + ')" '
            + 'style="display:block;width:100%;text-align:left;background:rgba(255,255,255,.1);'
            + 'border:1px solid rgba(255,255,255,.2);border-radius:4px;color:#fff;'
            + 'font-family:\'DM Mono\',monospace;font-size:.62rem;padding:6px 8px;'
            + 'margin-bottom:4px;cursor:pointer">'
            + (r.name || 'Unnamed').replace(/</g, '&lt;') + '</button>';
        }).join('');
    }
  } catch (err) {
    _geomLocateSetStatus('Search failed: ' + (err && err.message ? err.message : 'unknown') + '. Retry or skip.', true);
  }
}

function _geomLocatePickCourse(idx) {
  const r = _geomLocateResults && _geomLocateResults[idx];
  if (!r) { _geomLocateSetStatus('Invalid selection.', true); return; }
  _geomLocateInvokeSelect(r.osmId, r.center || null);
}

function _geomLocateInvokeSelect(osmId, center) {
  const cb = _geomLocateCallbacks && _geomLocateCallbacks.onSelect;
  /* Close first so the modal disappears even if callback throws */
  _geomLocateClose(true);
  if (cb) {
    try { cb(osmId, center); }
    catch(e) { console.error('[geomap] locate-modal onSelect failed:', e); }
  }
  _geomLocateCallbacks = null;
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    geomCreateMap,
    geomSearchByName,
    geomSearchByBounds,
    geomSearchByLocation,
    geomLoadByCenter,
    geomLoadByCourse,
    geomRenderGeometry,
    geomShowHole,
    geomRenderPath,
    geomDistanceYds,
    geomBearingDeg,
    geomPointInPolygon,
    geomLieAtPoint,
    geomStartGpsWatch,
    geomStopGpsWatch,
    geomGetCurrentPosition,
    geomGeocodeCity,  /* G4 */
    geomOpenLocateModal,  /* G5 */
    _geomLocateCitySearch, _geomLocatePanLoad, _geomLocateGpsLoad,
    _geomLocateSkip, _geomLocatePickCourse  /* G5 -- inline onclick handlers */
  });
}
