/**
 * geo.js \u2014 Pure geometric, distance, and math utilities for Gordy the Virtual Caddy.
 *
 * Rules for this module:
 *   \u2022 No DOM access (no document, window, localStorage).
 *   \u2022 No reads from module-level globals (bag, profile, rounds, vizYardMode, \u2026).
 *   \u2022 Every function is a pure transformation of its arguments.
 *   \u2022 All functions are named exports; nothing is default-exported.
 *
 * Functions that still depend on global state (getDispersion, vizGetDisp,
 * calcVizMaxRange, getYardLabel) are NOT extracted here \u2014 they are candidates
 * for a follow-up pass once the relevant globals (FLIGHT_DATA, bag, profile)
 * are themselves modularised.
 */

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Club classification
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Map a club object to a FLIGHT_DATA key.
 * Used by the dispersion/caddie-session path.
 *
 * Returns one of:
 *   'Driver' | 'Fairway Wood' | 'Hybrid' | 'Chipper' | 'Wedge' |
 *   'Iron-Long' | 'Iron-Mid' | 'Iron-Short' | null
 *
 * @param {{ type: string, identifier?: string }} c
 * @returns {string|null}
 */
export function flightKey(c) {
  if (c.type === 'Driver')       return 'Driver';
  if (c.type === 'Fairway Wood') return 'Fairway Wood';
  if (c.type === 'Hybrid')       return 'Hybrid';
  if (c.type === 'Chipper')      return 'Chipper';
  if (c.type === 'Wedge')        return 'Wedge';
  if (c.type === 'Iron') {
    const id = (c.identifier || '').toLowerCase();
    const loftMatch = id.match(/(\d+)\s*\u00b0/);
    if (loftMatch) {
      const loft = parseInt(loftMatch[1]);
      if (loft <= 27) return 'Iron-Long';
      if (loft <= 38) return 'Iron-Mid';
      return 'Iron-Short';
    }
    const numMatch = id.match(/^(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1]);
      if (n <= 4) return 'Iron-Long';
      if (n <= 7) return 'Iron-Mid';
      return 'Iron-Short';
    }
    return 'Iron-Mid'; // fallback
  }
  return null;
}

/**
 * Viz-specific club-to-flight-key mapping.
 * Differs from flightKey in two ways:
 *   1. Putter returns null explicitly.
 *   2. Hybrid is split into 'Hybrid' vs 'Iron-Short' based on loft/number.
 *   3. Chipper is merged into 'Wedge'.
 *
 * @param {{ type: string, identifier?: string, loft?: number|string }} c
 * @returns {string|null}
 */
export function vizFlightKey(c) {
  const t = c.type, id = (c.identifier || '').toLowerCase(), loft = +c.loft || 0;
  if (t === 'Driver')                    return 'Driver';
  if (t === 'Fairway Wood')              return 'Fairway Wood';
  if (t === 'Wedge' || t === 'Chipper')  return 'Wedge';
  if (t === 'Putter')                    return null;
  if (t === 'Hybrid') {
    const n = id.match(/(\d+)h/);
    return (!n || +n[1] <= 6) && loft <= 30 ? 'Hybrid' : 'Iron-Short';
  }
  if (t === 'Iron') {
    if (loft <= 27) return 'Iron-Long';
    if (loft <= 38) return 'Iron-Mid';
    return 'Iron-Short';
  }
  return 'Iron-Mid';
}

/**
 * Return true if the club belongs to the "long" category for gap-threshold
 * purposes (Driver, Fairway Wood, Iron-Long, or a low-lofted/low-numbered Hybrid).
 * Long clubs use a 20-yd gap threshold; all others use 15 yd.
 *
 * @param {{ type: string, identifier?: string }} c
 * @returns {boolean}
 */
export function isLongClub(c) {
  const k = flightKey(c);
  if (k === 'Driver' || k === 'Fairway Wood' || k === 'Iron-Long') return true;
  if (k === 'Hybrid') {
    const id = (c.identifier || '').toLowerCase();
    const loftMatch = id.match(/(\d+)\s*\u00b0/);
    if (loftMatch) return parseInt(loftMatch[1]) <= 30;
    const numMatch = id.match(/(\d+)[h]/);
    if (numMatch) return parseInt(numMatch[1]) <= 6;
    return true; // unidentifiable hybrid \u2192 treat as long
  }
  return false;
}

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Handicap-tier lookup
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Convert a handicap index to a 0-based tier index (0 = scratch, 5 = 25+).
 * Null handicap defaults to tier 3 (15\u201319 band).
 *
 * @param {number|null} hcp
 * @returns {0|1|2|3|4|5}
 */
export function tierIndex(hcp) {
  const h = hcp === null ? 3 : +hcp;
  if (h < 5)  return 0;
  if (h < 10) return 1;
  if (h < 15) return 2;
  if (h < 20) return 3;
  if (h < 25) return 4;
  return 5;
}

/**
 * Viz variant of tierIndex.
 * Identical logic but accepts undefined/NaN inputs gracefully (coerces to 15).
 *
 * @param {number|null|undefined} hcp
 * @returns {0|1|2|3|4|5}
 */
export function vizTierIdx(hcp) {
  const h = +hcp || 15;
  if (h < 5)  return 0;
  if (h < 10) return 1;
  if (h < 15) return 2;
  if (h < 20) return 3;
  if (h < 25) return 4;
  return 5;
}

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Handicap & scoring mathematics
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Calculate the WHS handicap differential for a single round.
 * Formula: (gross - courseRating) \u00d7 113 / slopeRating
 *
 * @param {number|string} gross  Gross score
 * @param {number|string} rating Course rating
 * @param {number|string} slope  Slope rating
 * @returns {number|null}        Differential rounded to 1 dp, or null if inputs invalid
 */
export function calcDiff(gross, rating, slope) {
  const g = +gross, r = +rating, s = +slope;
  if (!g || !r || !s) return null;
  return Math.round((g - r) * 113 / s * 10) / 10;
}

/**
 * Derive a WHS handicap index from an array of round objects.
 * Uses best 1\u20138 differentials scaled by 0.96, per the WHS lookup table.
 * Rounds marked `countForHandicap: false` are excluded.
 *
 * @param {Array<{ diff: number|null, countForHandicap?: boolean }>} rounds
 * @returns {number|null}
 */
export function calcHandicap(rounds) {
  const eligible = rounds.filter(r => r.countForHandicap !== false);
  const diffs = eligible
    .map(r => r.diff)
    .filter(d => d !== null && d !== undefined)
    .sort((a, b) => a - b);
  if (!diffs.length) return null;
  const n = diffs.length;
  const take =
    n >= 20 ? 8 : n >= 17 ? 7 : n >= 15 ? 6 : n >= 12 ? 5 :
    n >= 10 ? 4 : n >= 9  ? 3 : n >= 7  ? 2 : 1;
  const use = diffs.slice(0, take);
  return Math.round(use.reduce((a, b) => a + b, 0) / use.length * 0.96 * 10) / 10;
}

/**
 * Convert a handicap index to a playing handicap for a specific set of tee conditions.
 *
 * @param {number|null} idx    Handicap index
 * @param {number|string} slope  Slope rating
 * @param {number|string} rating Course rating
 * @param {number|string} par    Par
 * @returns {number|null}
 */
export function calcPlayHcp(idx, slope, rating, par) {
  if (idx === null || !slope || !rating || !par) return null;
  return Math.round(idx * (+slope / 113) + (+rating - +par));
}

// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Session / distance statistics
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Aggregate min/max across all distance sessions for a club.
 *
 * @param {Array<{ min: number|string, max: number|string, date: string }>} sessions
 * @returns {{ avgMin: number|null, avgMax: number|null, count: number, lastDate: string|null }|null}
 */
export function deriveStats(sessions) {
  if (!sessions || !sessions.length) return null;
  const mins = sessions.map(s => +s.min).filter(n => n > 0);
  const maxs = sessions.map(s => +s.max).filter(n => n > 0);
  if (!mins.length && !maxs.length) return null;
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  return {
    avgMin: avg(mins),
    avgMax: avg(maxs),
    count: sessions.length,
    lastDate: [...sessions].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? null,
  };
}

/**
 * Apply confidence-based floor adjustment to a club's distance range.
 *
 * The maximum always stays at avgMax (best-strike ceiling is fixed).
 * Confidence only adjusts the minimum (floor):
 *   conf 1-2 \u2192 \u221210%   conf 3 \u2192 \u22125%   conf 4 \u2192 no change   conf 5 \u2192 +5%
 *
 * If the raw gap (max \u2212 min) is already within threshold the range is
 * returned unadjusted ("gap suppression").
 *
 * @param {{ avgMin: number|null, avgMax: number|null }} stats
 * @param {{ confidence?: number|string, type?: string, identifier?: string }} c
 * @returns {{
 *   impMin: number, impMax: number,
 *
