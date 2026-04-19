/**
 * geo.js - Pure geometric, distance, and math utilities for Gordy the Virtual Caddy.
 *
 * Rules for this module:
 *   - No DOM access (no document, window, localStorage).
 *   - No reads from module-level globals (bag, profile, rounds, vizYardMode, ...).
 *   - Every function is a pure transformation of its arguments.
 *   - All functions are named exports; nothing is default-exported.
 *
 * Functions that still depend on global state (getDispersion, vizGetDisp,
 * calcVizMaxRange, getYardLabel) are NOT extracted here -- they are candidates
 * for a follow-up pass once the relevant globals (FLIGHT_DATA, bag, profile)
 * are themselves modularised.
 */

// -----------------------------------------------------------------------------
// Club classification
// -----------------------------------------------------------------------------

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
    const loftMatch = id.match(/(\d+)\s*°/);
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
    const loftMatch = id.match(/(\d+)\s*°/);
    if (loftMatch) return parseInt(loftMatch[1]) <= 30;
    const numMatch = id.match(/(\d+)[h]/);
    if (numMatch) return parseInt(numMatch[1]) <= 6;
    return true; // unidentifiable hybrid → treat as long
  }
  return false;
}

// -----------------------------------------------------------------------------
// Handicap-tier lookup
// -----------------------------------------------------------------------------

/**
 * Convert a handicap index to a 0-based tier index (0 = scratch, 5 = 25+).
 * Null handicap defaults to tier 3 (15–19 band).
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

// -----------------------------------------------------------------------------
// Handicap & scoring mathematics
// -----------------------------------------------------------------------------

/**
 * Calculate the WHS handicap differential for a single round.
 * Formula: (gross - courseRating) × 113 / slopeRating
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
 * Uses best 1–8 differentials scaled by 0.96, per the WHS lookup table.
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

// -----------------------------------------------------------------------------
// Session / distance statistics
// -----------------------------------------------------------------------------

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
 *   conf 1-2 → −10%   conf 3 → −5%   conf 4 → no change   conf 5 → +5%
 *
 * If the raw gap (max − min) is already within threshold the range is
 * returned unadjusted ("gap suppression").
 *
 * @param {{ avgMin: number|null, avgMax: number|null }} stats
 * @param {{ confidence?: number|string, type?: string, identifier?: string }} c
 * @returns {{
 *   impMin: number, impMax: number,
 *   adjusted: boolean, suppressed: boolean,
 *   reason: string
 * }|null}
 */
export function calcImplied(stats, c) {
  if (!stats || (!stats.avgMin && !stats.avgMax)) return null;
  const mn = stats.avgMin || 0;
  const mx = stats.avgMax || mn;
  const gap = mx - mn;
  const threshold = isLongClub(c) ? 20 : 15;
  if (gap <= threshold) {
    return {
      impMin: mn, impMax: mx,
      adjusted: false, suppressed: true,
      reason: `Gap ${gap} yds <= ${threshold} yd threshold -- unadjusted`,
    };
  }
  const conf = parseInt(c.confidence) || 4;
  let minMult, label;
  if      (conf <= 2) { minMult = 0.90; label = 'Confidence 1-2 -- min -10%'; }
  else if (conf === 3) { minMult = 0.95; label = 'Confidence 3 -- min -5%'; }
  else if (conf === 4) { minMult = 1.00; label = 'Confidence 4 -- baseline'; }
  else                 { minMult = 1.05; label = 'Confidence 5 -- min +5% (consistent striker)'; }
  if (minMult === 1.00) {
    return { impMin: mn, impMax: mx, adjusted: false, suppressed: false, reason: label };
  }
  return {
    impMin: Math.round(mn * minMult), impMax: mx,
    adjusted: true, suppressed: false, reason: label,
  };
}

// -----------------------------------------------------------------------------
// Visualisation geometry & colour
// -----------------------------------------------------------------------------

/**
 * Lighten a hex colour by blending it toward white by factor f (0–1).
 *
 * @param {string} hex  e.g. '#3d6b35'
 * @param {number} f    0 = no change, 1 = white
 * @returns {string}
 */
export function vizLightenHex(hex, f) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return '#' + [r, g, b]
    .map(v => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Approximation of the standard normal CDF using a rational polynomial.
 * Used to estimate fairway-hit probability from lateral dispersion.
 *
 * @param {number} x
 * @returns {number}  Value in [0, 1]
 */
export function vizNormCdf(x) {
  return 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-2 * x * x / Math.PI)));
}

/**
 * Build an SVG path string for an asymmetric, tilted ellipse.
 *
 * The ellipse is divided into four quadrants to allow independent radii:
 *   rxR  right radius  rxL  left radius
 *   ryU  upper radius  ryD  lower radius
 *
 * Control-point magic number 0.552 is the standard cubic Bézier approximation
 * for a quarter-circle arc.
 *
 * @param {number} cx    Centre X (canvas px)
 * @param {number} cy    Centre Y (canvas px)
 * @param {number} rxR   Right semi-axis (px)
 * @param {number} rxL   Left semi-axis (px)
 * @param {number} ryU   Upper semi-axis (px)
 * @param {number} ryD   Lower semi-axis (px)
 * @param {number} tilt  Rotation in degrees (positive = clockwise)
 * @returns {string}     SVG path data
 */
export function vizEllipsePath(cx, cy, rxR, rxL, ryU, ryD, tilt) {
  const kr = rxR * 0.552, kl = rxL * 0.552;
  const ku = ryU * 0.552, kd = ryD * 0.552;
  const r  = tilt * Math.PI / 180;
  const co = Math.cos(r), si = Math.sin(r);
  const rt = (x, y) => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * co - dy * si, cy + dx * si + dy * co];
  };
  const p = (x, y) => { const [a, b] = rt(x, y); return `${a.toFixed(1)} ${b.toFixed(1)}`; };
  return [
    `M ${p(cx, cy - ryU)}`,
    `C ${p(cx + kr, cy - ryU)},${p(cx + rxR, cy - ku)},${p(cx + rxR, cy)}`,
    `C ${p(cx + rxR, cy + kd)},${p(cx + kr,  cy + ryD)},${p(cx, cy + ryD)}`,
    `C ${p(cx - kl, cy + ryD)},${p(cx - rxL, cy + kd)},${p(cx - rxL, cy)}`,
    `C ${p(cx - rxL, cy - ku)},${p(cx - kl,  cy - ryU)},${p(cx, cy - ryU)} Z`,
  ].join(' ');
}
export function fmtDate(iso) { if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${m}/${d}/${y.slice(2)}`; }

/* SLUG1 -- deterministic stable key: brand|type|identifier|loft|stiffness
   normalized lowercase, spaces->'-', non-alphanum stripped.
   Written at creation + backfilled on load(). Never reassigned post-create.
   Placed here (not clubs.js) to avoid circular import with store.js.
   Read-side still uses legacy keys until Pass 2. */
export function clubSlug(c) {
  if(!c) return '';
  var norm = function(v) {
    return String(v==null?'':v).toLowerCase().trim().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'');
  };
  return [norm(c.brand), norm(c.type), norm(c.identifier), norm(c.loft), norm(c.stiffness)].join('|');
}

/* CLEAN11 -- localISO centralised from live-round.js, range.js, viz.js (definitions were identical) */
export function localISO() {
  var n=new Date(), p=function(x){return x<10?'0'+x:''+x;};
  return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+'T'+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds());
}

/* ASKB-1 -- shared miss/tag/flight-path derivation extracted from ui.js renderPerfSummary.
   Operates on a {bull, inner[8], outer[8], fp{str,ltr,rtl}} aggregate. Pure. */
export var BUCKET_NAMES = ['Long','Long-Right','Right','Short-Right','Short','Short-Left','Left','Long-Left'];

export function tagLookup(path, miss, sev) {
  if (!miss || miss === '\u2014') return 'Target';
  if (path === 'Str') {
    if (miss === 'Right' || miss === 'Long-Right') return 'Push';
    if (miss === 'Left'  || miss === 'Long-Left')  return 'Pull';
    if (miss === 'Short') return 'Chunk/Thin';
    return '\u2014';
  }
  if (path === 'LtR') {
    if (miss === 'Right' || miss === 'Long-Right') return sev === 'Inner' ? 'Fade' : 'Slice';
    if (miss === 'Left'  || miss === 'Long-Left')  return 'Double Cross (LtR)';
    return '\u2014';
  }
  if (path === 'RtL') {
    if (miss === 'Left'  || miss === 'Long-Left')  return sev === 'Inner' ? 'Draw' : 'Hook';
    if (miss === 'Right' || miss === 'Long-Right') return 'Double Cross (RtL)';
    return '\u2014';
  }
  return '\u2014';
}

export function dominantMiss(d) {
  var buckets = [], i;
  for (i = 0; i < 8; i++) buckets.push({ i: i, n: (d.inner[i]||0) + (d.outer[i]||0), outerN: d.outer[i]||0 });
  buckets.sort(function(a,b){ return b.n - a.n; });
  if (!buckets[0].n) return '\u2014';
  if (buckets[0].n > buckets[1].n) return BUCKET_NAMES[buckets[0].i];
  var topN = buckets[0].n, tied = buckets.filter(function(b){ return b.n === topN; });
  if (tied.length === 2) {
    var ai = tied[0].i, bi = tied[1].i;
    if (tied[0].outerN !== tied[1].outerN) return BUCKET_NAMES[tied[0].outerN > tied[1].outerN ? tied[0].i : tied[1].i];
    var diff = Math.abs(ai - bi);
    if (diff === 4) {
      var an = BUCKET_NAMES[ai], bn = BUCKET_NAMES[bi];
      return ((an === 'Right' || bn === 'Right') || (an === 'Left' || bn === 'Left')) ? 'Two-Way Miss (L/R)' : 'Two-Way Miss (Dist)';
    }
    var mn = Math.min(ai, bi), mx = Math.max(ai, bi);
    var adj = (mx - mn === 1) || (mn === 0 && mx === 7);
    if (adj) {
      var combos = {0:{'1':'Broad Long-Right'},1:{'2':'Broad Right'},2:{'3':'Broad Short-Right'},3:{'4':'Broad Short'},4:{'5':'Broad Short-Left'},5:{'6':'Broad Left'},6:{'7':'Broad Long-Left'}};
      var wrap = (mn === 0 && mx === 7) ? 'Broad Long' : null;
      return wrap || (combos[mn] && combos[mn][mx]) || BUCKET_NAMES[buckets[0].i];
    }
  }
  return BUCKET_NAMES[buckets[0].i];
}

export function shotTag(d, miss) {
  var innerTot = d.inner.reduce(function(n,v){ return n + v; }, 0);
  var outerTot = d.outer.reduce(function(n,v){ return n + v; }, 0);
  var grandTot = d.bull + innerTot + outerTot;
  if (!grandTot) return '\u2014';
  if (d.bull / grandTot > 0.5 || !miss || miss === '\u2014') return 'Target';
  var sev = innerTot >= outerTot ? 'Inner' : 'Outer';
  var fp = d.fp, fpTot = fp.str + fp.ltr + fp.rtl;
  if (!fpTot) return '\u2014';
  var paths = [['Str',fp.str],['LtR',fp.ltr],['RtL',fp.rtl]];
  paths.sort(function(a,b){ return b[1] - a[1]; });
  if (paths[0][1] > paths[1][1]) return tagLookup(paths[0][0], miss, sev);
  if (miss.indexOf('Two-Way') === 0) return 'Two-Way Miss';
  var sevW = { Hook:3, Slice:3, Pull:2, Push:2, Draw:1, Fade:1 };
  var t1 = tagLookup(paths[0][0], miss, sev), t2 = tagLookup(paths[1][0], miss, sev);
  return (sevW[t1]||0) >= (sevW[t2]||0) ? t1 : t2;
}

/* ASKB-1 -- aggregate observed dispersion for a club across rangeSessions and/or rounds.
   Pure: all state passed as args (geo.js contract).
   Returns null if sampleSize < minShots (no cross-source padding).
   clubSlug is the stable identifier (SLUG1). clubId/name fallback for legacy entries is handled by callers. */
export function aggregateObservedDispersion(clubSlug, options) {
  var opts = options || {};
  var source       = opts.source   || 'both';   // 'rounds' | 'range' | 'both'
  var minShots     = opts.minShots != null ? opts.minShots : 5;
  var rangeSessions = opts.rangeSessions || [];
  var rounds       = opts.rounds   || [];
  var bag          = opts.bag      || [];
  if (!clubSlug) return null;

  // Resolve club for legacy-id matching (range sessions may have clubSlug OR clubId)
  var clubObj = bag.find(function(c){ return c.slug === clubSlug; });
  var legacyId = clubObj ? clubObj.id : null;

  // Aggregate into {bull, inner[8], outer[8], fp{str,ltr,rtl}} and fpCounts per segment
  var d = { bull:0, inner:[0,0,0,0,0,0,0,0], outer:[0,0,0,0,0,0,0,0], fp:{ str:0, ltr:0, rtl:0 } };
  var fpCounts = { bull:{straight:0,'left-to-right':0,'right-to-left':0} };
  var i;
  for (i = 0; i < 8; i++) {
    fpCounts['inner-'+i] = { straight:0, 'left-to-right':0, 'right-to-left':0 };
    fpCounts['outer-'+i] = { straight:0, 'left-to-right':0, 'right-to-left':0 };
  }
  var sampleSize = 0;

  var addFp = function(segKey, fpName) {
    if (fpName === 'straight')            d.fp.str++;
    else if (fpName === 'left-to-right')  d.fp.ltr++;
    else if (fpName === 'right-to-left')  d.fp.rtl++;
    if (fpCounts[segKey] && fpCounts[segKey][fpName] !== undefined) fpCounts[segKey][fpName]++;
  };

  // Range pass -- session.clubSummary already bucketed
  if (source === 'range' || source === 'both') {
    rangeSessions.forEach(function(s) {
      if (!s || !s.committed || !s.clubSummary) return;
      s.clubSummary.forEach(function(cs) {
        var match = cs.clubSlug === clubSlug || (legacyId && cs.clubId === legacyId);
        if (!match) return;
        (cs.targets || []).forEach(function(t) {
          sampleSize += t.shotCount || 0;
          var dp = t.dispersion; if (!dp) return;
          d.bull += dp.bull.total || 0;
          var fps = dp.bull.flightPaths || {};
          Object.keys(fps).forEach(function(k){ if (fpCounts.bull[k] !== undefined) fpCounts.bull[k] += fps[k]||0; });
          d.fp.str += fps.straight || 0;
          d.fp.ltr += fps['left-to-right'] || 0;
          d.fp.rtl += fps['right-to-left'] || 0;
          for (var j = 0; j < 8; j++) {
            if (dp.inner[j]) {
              d.inner[j] += dp.inner[j].total || 0;
              var ifps = dp.inner[j].flightPaths || {};
              d.fp.str += ifps.straight || 0; d.fp.ltr += ifps['left-to-right'] || 0; d.fp.rtl += ifps['right-to-left'] || 0;
              Object.keys(ifps).forEach(function(k){ if (fpCounts['inner-'+j][k] !== undefined) fpCounts['inner-'+j][k] += ifps[k]||0; });
            }
            if (dp.outer[j]) {
              d.outer[j] += dp.outer[j].total || 0;
              var ofps = dp.outer[j].flightPaths || {};
              d.fp.str += ofps.straight || 0; d.fp.ltr += ofps['left-to-right'] || 0; d.fp.rtl += ofps['right-to-left'] || 0;
              Object.keys(ofps).forEach(function(k){ if (fpCounts['outer-'+j][k] !== undefined) fpCounts['outer-'+j][k] += ofps[k]||0; });
            }
          }
        });
      });
    });
  }

  // Rounds pass -- raw shots
  if (source === 'rounds' || source === 'both') {
    rounds.forEach(function(r) {
      if (!r || !r.holes) return;
      r.holes.forEach(function(h) {
        (h.shots || []).forEach(function(shot) {
          if (!shot || !shot.radial_ring) return;
          var match = shot.clubSlug === clubSlug || (legacyId && shot.clubId === legacyId);
          if (!match) return;
          sampleSize++;
          var ring = shot.radial_ring, seg = shot.radial_segment;
          var segKey = null;
          if (ring === 'bull') { d.bull++; segKey = 'bull'; }
          else if (ring === 'inner' && seg != null) { d.inner[+seg]++; segKey = 'inner-'+seg; }
          else if (ring === 'outer' && seg != null) { d.outer[+seg]++; segKey = 'outer-'+seg; }
          if (shot.flight_path && segKey) addFp(segKey, shot.flight_path);
        });
      });
    });
  }

  if (sampleSize < minShots) return null;

  var miss = dominantMiss(d);
  var tag  = shotTag(d, miss);
  var fpTot = d.fp.str + d.fp.ltr + d.fp.rtl;
  var pct = function(n){ return fpTot > 0 ? Math.round(n / fpTot * 100) : 0; };
  return {
    sampleSize: sampleSize,
    missDirection: miss,
    flightPathMix: { str: pct(d.fp.str), ltr: pct(d.fp.ltr), rtl: pct(d.fp.rtl) },
    shotTag: tag,
    bucketCounts: d,
    fpCounts: fpCounts
  };
}
