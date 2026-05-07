/**
 * geoSummary.js
 * Converts a loaded CDN course geo object (as returned by geomLoadByCourse)
 * into compact per-hole text summaries for inclusion in the AI export.
 *
 * Depends on: window.turf (already loaded by index.html)
 * No network calls. No side effects. Pure derivation from in-memory geo data.
 *
 * Public API:
 *   buildGeoSummaries(geo)  ->  Map<holeNumber, string>
 *   geoLineForHole(geo, holeNumber)  ->  string  ("GEO | ..." or "")
 *
 * Output format per hole (fits on one line, ~15-25 tokens):
 *   GEO | straight | hazard=bunker-left@195,water-right@240 | green=open
 *   GEO | dogleg-left@210 | clear | green=bunker-right
 *   GEO | dogleg-right@180 | hazard=water-left@160 | green=open
 */

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

// Full union of all hazard types across gps-view and geoSummary. Cart path, driving range, tee ignored.
var HAZARD_TYPES = ['bunker', 'water_hazard', 'lateral_water_hazard', 'woods', 'rough'];

// Minimum bearing change (degrees) across the full centreline to call a dogleg.
var DOGLEG_THRESHOLD_DEG = 20;

// Corridor half-width in yards — matches gps-view _gvCorridorCheck perpYds <= 40.
var CORRIDOR_WIDTH_YDS = 40;

// Green zone: hazard centroid within this direct radius of the green anchor is flagged green-zone.
// Matches gps-view philosophy: same geometry, direct distance, 30-yard radius.
var GREEN_RADIUS_YDS = 30;

// ---------------------------------------------------------------------------
// Geometry helpers (no Turf dependency for simple cases)
// ---------------------------------------------------------------------------

/**
 * Compute centroid of a GeoJSON feature (Polygon or LineString).
 * Returns [lon, lat] or null.
 */
function _centroid(feature) {
  try {
    var c = window.turf.centroid(feature);
    return c.geometry.coordinates; // [lon, lat]
  } catch (e) {
    return null;
  }
}

/**
 * Great-circle distance in yards between two [lon,lat] points.
 */
function _yds(a, b) {
  try {
    return Math.round(
      window.turf.distance(window.turf.point(a), window.turf.point(b), { units: 'yards' })
    );
  } catch (e) {
    return null;
  }
}

/**
 * Bearing in degrees (0-360) from point a to point b.
 */
function _bearing(a, b) {
  try {
    var raw = window.turf.bearing(window.turf.point(a), window.turf.point(b));
    return ((raw % 360) + 360) % 360;
  } catch (e) {
    return null;
  }
}

/**
 * Signed bearing difference: how far right (+) or left (-) is target
 * relative to the reference forward bearing. Range: -180 to +180.
 */
function _bearingDiff(forwardBearing, toBearing) {
  var diff = ((toBearing - forwardBearing) + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff; // positive = right, negative = left
}

// ---------------------------------------------------------------------------
// Centreline analysis
// ---------------------------------------------------------------------------

/**
 * Walk the hole centreline, returning:
 *   totalYds       - playing length along centreline
 *   dogleg         - null | { dir: 'left'|'right', yds: number, angleDeg: number }
 *   segmentYds     - array of cumulative yardages at each waypoint
 */
function _analysecentreline(line) {
  var result = { totalYds: 0, dogleg: null, segmentYds: [0] };
  if (!line || line.length < 2) return result;

  var cumYds = 0;
  var bearings = [];

  for (var i = 0; i < line.length - 1; i++) {
    var segYds = _yds(line[i], line[i + 1]);
    if (segYds === null) continue;
    cumYds += segYds;
    result.segmentYds.push(cumYds);
    var brg = _bearing(line[i], line[i + 1]);
    if (brg !== null) bearings.push({ brg: brg, cumYds: cumYds - segYds / 2 });
  }

  result.totalYds = cumYds;

  // Detect dogleg: compare first segment bearing to last segment bearing.
  // Use first and last bearing to measure total directional change.
  if (bearings.length >= 2) {
    var firstBrg = bearings[0].brg;
    var lastBrg  = bearings[bearings.length - 1].brg;
    var diff = _bearingDiff(firstBrg, lastBrg);

    if (Math.abs(diff) >= DOGLEG_THRESHOLD_DEG) {
      // Apex yardage: find the waypoint with maximum cumulative bearing change from start.
      var maxChange = 0;
      var apexYds = 0;
      var runningBrg = firstBrg;
      for (var j = 1; j < bearings.length; j++) {
        var change = Math.abs(_bearingDiff(runningBrg, bearings[j].brg));
        if (change > maxChange) {
          maxChange = change;
          apexYds = bearings[j].cumYds;
        }
      }

      result.dogleg = {
        dir: diff > 0 ? 'right' : 'left',
        yds: Math.round(apexYds),
        angleDeg: Math.round(Math.abs(diff))
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hazard assignment and classification
// ---------------------------------------------------------------------------

/**
 * Get the hazard type label for export. Normalises both water variants.
 */
function _hazardLabel(golfType) {
  if (golfType === 'water_hazard' || golfType === 'lateral_water_hazard') return 'water';
  return golfType; // 'bunker', 'rough'
}

/**
 * Find the nearest point on a centreline to a given point,
 * returning { yds: cumulativeYardsAlongLine, pt: [lon,lat] }.
 */
function _nearestOnLine(line, pt) {
  var bestDist = Infinity;
  var bestYds  = 0;
  var cumYds   = 0;

  for (var i = 0; i < line.length - 1; i++) {
    var segStart = line[i];
    var segEnd   = line[i + 1];
    var segLen   = _yds(segStart, segEnd) || 0;

    // Nearest point on this segment using Turf
    try {
      var segLine = window.turf.lineString([segStart, segEnd]);
      var nearest = window.turf.nearestPointOnLine(segLine, window.turf.point(pt));
      var dist = _yds(pt, nearest.geometry.coordinates);
      if (dist !== null && dist < bestDist) {
        bestDist = dist;
        // Approximate cumulative yardage: segment start + fraction along segment
        var frac = nearest.properties.location || 0; // metres along segment from turf
        var fracYds = _yds(segStart, nearest.geometry.coordinates) || 0;
        bestYds = cumYds + fracYds;
      }
    } catch (e) { /* skip bad segment */ }

    cumYds += segLen;
  }

  return { yds: Math.round(bestYds) };
}

/**
 * Determine which side of the centreline (at the nearest point) a hazard
 * centroid sits. Returns 'left' | 'right'.
 */
function _sideOfLine(line, centroid) {
  if (!line || line.length < 2) return 'right';

  var bestDist = Infinity;
  var segIdx   = 0;

  for (var i = 0; i < line.length - 1; i++) {
    try {
      var segLine = window.turf.lineString([line[i], line[i + 1]]);
      var nearest = window.turf.nearestPointOnLine(segLine, window.turf.point(centroid));
      var d = nearest.properties.dist; // distance in km from turf
      if (d < bestDist) { bestDist = d; segIdx = i; }
    } catch (e) {}
  }

  var forwardBearing = _bearing(line[segIdx], line[segIdx + 1]);
  var toBearing      = _bearing(line[segIdx], centroid);
  if (forwardBearing === null || toBearing === null) return 'right';

  var diff = _bearingDiff(forwardBearing, toBearing);
  return diff >= 0 ? 'right' : 'left';
}

/**
 * Corridor check — mirrors gps-view _gvCorridorCheck exactly.
 * Returns true if hazardCentroid falls within CORRIDOR_WIDTH_YDS of the
 * startLL->endLL axis and between the two endpoints (t in [0,1]).
 * Also returns side: 'left'|'right'.
 */
function _corridorCheck(startLL, endLL, hazardCentroid) {
  if (!startLL || !endLL || !hazardCentroid) return null;
  var lat0 = startLL[1] * Math.PI / 180;
  var R = 6371000, M_TO_YDS = 1.0936133;
  var ax = (endLL[0] - startLL[0]) * Math.PI / 180 * Math.cos(lat0) * R;
  var ay = (endLL[1] - startLL[1]) * Math.PI / 180 * R;
  var aLen = Math.sqrt(ax * ax + ay * ay);
  if (aLen < 1e-3) return null;
  var ux = ax / aLen, uy = ay / aLen;
  var hx = (hazardCentroid[0] - startLL[0]) * Math.PI / 180 * Math.cos(lat0) * R;
  var hy = (hazardCentroid[1] - startLL[1]) * Math.PI / 180 * R;
  var t = (hx * ux + hy * uy) / aLen;
  var rx = uy, ry = -ux;
  var perp = Math.abs(hx * rx + hy * ry);
  var perpYds = perp * M_TO_YDS;
  var inCorridor = (t >= 0 && t <= 1 && perpYds <= CORRIDOR_WIDTH_YDS);
  var cross = ux * hy - uy * hx;
  var side = cross > 0 ? 'left' : 'right'; // matches gps-view L/R convention, spelled out
  return { inCorridor: inCorridor, side: side };
}

/**
 * Given a hole and all course polygons, return an array of hazard descriptors
 * relevant to this hole, sorted by yardage from tee.
 *
 * A hazard is included if it falls within the 40-yard corridor (tee->green)
 * OR within GREEN_RADIUS_YDS direct distance of the green anchor — same
 * philosophy as gps-view's two-corridor + green-zone model.
 *
 * Each descriptor: { label: string, side: string, yds: number, nearGreen: boolean }
 */
function _holeHazards(hole, allFeatures) {
  if (!hole.line || hole.line.length < 2) return [];
  var tee   = hole.line[0];
  var green = Array.isArray(hole.green) ? hole.green : hole.line[hole.line.length - 1];

  var hazards = [];

  for (var i = 0; i < allFeatures.length; i++) {
    var f = allFeatures[i];
    if (!f || !f.properties) continue;

    var golfType = f.properties.golf;
    if (HAZARD_TYPES.indexOf(golfType) === -1) continue;

    var c = _centroid(f);
    if (!c) continue;

    // Test 1: corridor tee->green (mirrors gps-view ball->aim->green corridor)
    var corr = _corridorCheck(tee, green, c);
    var inCorridor = corr && corr.inCorridor;

    // Test 2: within GREEN_RADIUS_YDS direct distance of green anchor
    var distToGreen = _yds(c, green);
    var nearGreen = distToGreen !== null && distToGreen <= GREEN_RADIUS_YDS;

    if (!inCorridor && !nearGreen) continue;

    var nearest = _nearestOnLine(hole.line, c);
    // Side from corridor check if available; fall back to centreline side
    var side = (corr && corr.side) ? corr.side : _sideOfLine(hole.line, c);

    hazards.push({
      label:     _hazardLabel(golfType),
      side:      side,
      yds:       nearest.yds,
      nearGreen: nearGreen
    });
  }

  // Sort by yardage from tee
  hazards.sort(function (a, b) { return a.yds - b.yds; });
  return hazards;
}

// ---------------------------------------------------------------------------
// Green approach summary
// ---------------------------------------------------------------------------

/**
 * Summarise green-area hazards as a short string.
 * Returns 'open' if nothing found near the green.
 */
function _greenSummary(hazards) {
  var greenHazards = hazards.filter(function (h) { return h.nearGreen; });
  if (!greenHazards.length) return 'open';

  // Group by side, prefer bunker label over rough
  var left  = greenHazards.filter(function (h) { return h.side === 'left'; });
  var right = greenHazards.filter(function (h) { return h.side === 'right'; });

  var parts = [];
  if (left.length)  parts.push(left[0].label  + '-left');
  if (right.length) parts.push(right[0].label + '-right');
  return parts.join(',') || 'open';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build per-hole geo summaries from a loaded geo object.
 *
 * @param {object} geo  Return value of geomLoadByCourse: { holes, polygons, center, bounds }
 * @returns {Map<number, string>}  Key = hole number (int), value = GEO line string
 */
function buildGeoSummaries(geo) {
  var result = new Map();
  if (!geo || !geo.holes || !geo.polygons) return result;

  var allFeatures = (geo.polygons && geo.polygons.features) || [];

  var keys = Object.keys(geo.holes);
  for (var k = 0; k < keys.length; k++) {
    var hole = geo.holes[keys[k]];
    if (!hole || !hole.ref) continue;

    var holeNum = parseInt(hole.ref, 10);
    if (isNaN(holeNum)) continue;

    // 1. Centreline analysis
    var cl = _analysecentreline(hole.line);

    // 2. Hazard assignment
    var hazards = _holeHazards(hole, allFeatures);

    // 3. Non-green hazards (fairway / approach zone)
    var fairwayHazards = hazards.filter(function (h) { return !h.nearGreen; });

    // 4. Green summary
    var greenStr = _greenSummary(hazards);

    // 5. Dogleg string
    var doglegStr = 'straight';
    if (cl.dogleg) {
      doglegStr = 'dogleg-' + cl.dogleg.dir + '@' + cl.dogleg.yds;
    }

    // 6. Fairway hazard string — deduplicate adjacent same-type-same-side
    var hazardStr = 'clear';
    if (fairwayHazards.length) {
      var seen = {};
      var parts = [];
      for (var h = 0; h < fairwayHazards.length; h++) {
        var fh = fairwayHazards[h];
        var key = fh.label + '-' + fh.side;
        // Round to nearest 5 yds to avoid near-duplicate entries
        var ydsR = Math.round(fh.yds / 5) * 5;
        var entry = key + '@' + ydsR;
        if (!seen[entry]) { seen[entry] = true; parts.push(entry); }
      }
      if (parts.length) hazardStr = 'hazard=' + parts.join(',');
    }

    var line = 'GEO | ' + doglegStr + ' | ' + hazardStr + ' | green=' + greenStr;
    result.set(holeNum, line);
  }

  return result;
}

/**
 * Convenience: get the GEO line for a single hole number.
 * Returns empty string if geo not available or hole not found.
 *
 * @param {object} geo
 * @param {number|string} holeNumber
 * @returns {string}
 */
function geoLineForHole(geo, holeNumber) {
  var summaries = buildGeoSummaries(geo);
  return summaries.get(parseInt(holeNumber, 10)) || '';
}

// ---------------------------------------------------------------------------
// Expose on window (same pattern as geomap.js)
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.buildGeoSummaries = buildGeoSummaries;
  window.geoLineForHole    = geoLineForHole;
}
