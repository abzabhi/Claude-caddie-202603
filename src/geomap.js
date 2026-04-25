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
  water_hazard: '#5b9bd5',
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

  // 1. Geocode city.
  const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
  const geoRes = await _fetchWithTimeout(geoUrl);
  if (!geoRes.ok) throw new Error(`Nominatim HTTP ${geoRes.status}`);
  const geoData = await geoRes.json();
  if (!geoData || !geoData.length) return [];

  const cLat = geoData[0].lat;
  const cLon = geoData[0].lon;
  const safeName = courseName.replace(/"/g, '\\"');

  // 2. Overpass around the city. Reference used timeout:15 here - preserved.
  const q =
    '[out:json][timeout:15];\n' +
    '(\n' +
    `  node["leisure"="golf_course"]["name"~"${safeName}",i](around:50000, ${cLat}, ${cLon});\n` +
    `  way["leisure"="golf_course"]["name"~"${safeName}",i](around:50000, ${cLat}, ${cLon});\n` +
    `  relation["leisure"="golf_course"]["name"~"${safeName}",i](around:50000, ${cLat}, ${cLon});\n` +
    '); out center;';

  const osmRes = await _fetchWithTimeout(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: q }
  );
  if (!osmRes.ok) throw new Error(`Overpass HTTP ${osmRes.status}`);
  const osmData = await osmRes.json();
  if (!osmData.elements || !osmData.elements.length) return [];

  // 3. Sort by distance to city center.
  const cityPt = window.turf.point([parseFloat(cLon), parseFloat(cLat)]);
  const results = osmData.elements.map(_shapeSearchResult);
  results.sort((a, b) => {
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
    if (!e.tags.golf && (e.tags.natural === 'water' || e.tags.landuse === 'reservoir')) {
      e.tags.golf = 'water_hazard';
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
  const priority = ['green', 'tee', 'fairway', 'rough', 'bunker', 'water_hazard'];
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
// window exposure (for dev / non-module callers in G2 and G3)
// -----------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  Object.assign(window, {
    geomCreateMap,
    geomSearchByName,
    geomSearchByBounds,
    geomSearchByLocation,
    geomLoadByCenter,
    geomRenderGeometry,
    geomShowHole,
    geomRenderPath,
    geomDistanceYds,
    geomBearingDeg,
    geomPointInPolygon,
    geomLieAtPoint,
    geomStartGpsWatch,
    geomStopGpsWatch,
    geomGetCurrentPosition
  });
}
