/**
 * constants.js - Pure data tables for Gordy the Virtual Caddy.
 *
 * Rules for this module:
 *   - No DOM access, no localStorage, no side effects.
 *   - Every export is either a frozen object or a plain value.
 *   - Nothing here imports from any other Gordy module.
 *
 * Sources for flight/dispersion data:
 *   TrackMan (spin RPM, launch angle by HCP tier), GOLFTEC launch monitor
 *   study (lateral dispersion by HCP), Practical Golf / DECADE Scott Fawcett
 *   (driver lateral 65-70 yds scratch), Arccos GPS (driving accuracy, wedge
 *   proximity), HackMotion (longitudinal depth up to 30 yds avg players).
 */

// -----------------------------------------------------------------------------
// Club variant defaults
// Used by getVariantDefault() to pre-fill loft/shaft/stiffness when adding clubs.
// -----------------------------------------------------------------------------

export const CLUB_VARIANTS = {
  'Driver':       [{id:'Driver', loft:'10.5',shaft:45.75,stiffness:'Regular'}],
  'Fairway Wood': [{id:'3W',loft:'15',shaft:43.00,stiffness:'Regular'},{id:'5W',loft:'18',shaft:42.25,stiffness:'Regular'},
                   {id:'7W',loft:'21',shaft:41.50,stiffness:'Regular'},{id:'9W',loft:'24',shaft:40.75,stiffness:'Regular'}],
  'Hybrid':       [{id:'1H',loft:'16',shaft:40.50,stiffness:'Regular'},{id:'2H',loft:'17',shaft:40.25,stiffness:'Regular'},
                   {id:'3H',loft:'19',shaft:40.00,stiffness:'Regular'},{id:'4H',loft:'22',shaft:39.50,stiffness:'Regular'},
                   {id:'5H',loft:'25',shaft:39.00,stiffness:'Regular'},{id:'6H',loft:'28',shaft:38.50,stiffness:'Regular'},
                   {id:'7H',loft:'31',shaft:38.00,stiffness:'Regular'},{id:'8H',loft:'35',shaft:37.50,stiffness:'Regular'},
                   {id:'9H',loft:'38',shaft:37.00,stiffness:'Regular'}],
  'Iron':         [{id:'1i',loft:'16',shaft:39.50,stiffness:'Stiff'},{id:'2i',loft:'18',shaft:39.00,stiffness:'Stiff'},
                   {id:'3i',loft:'21',shaft:38.50,stiffness:'Regular'},{id:'4i',loft:'24',shaft:38.00,stiffness:'Regular'},
                   {id:'5i',loft:'27',shaft:37.50,stiffness:'Regular'},{id:'6i',loft:'30',shaft:37.00,stiffness:'Regular'},
                   {id:'7i',loft:'34',shaft:36.50,stiffness:'Regular'},{id:'8i',loft:'38',shaft:36.00,stiffness:'Regular'},
                   {id:'9i',loft:'42',shaft:35.50,stiffness:'Regular'}],
  'Wedge':        [{id:'PW',loft:'45',shaft:35.50,stiffness:'Regular'},{id:'GW 50',loft:'50',shaft:35.25,stiffness:'Stiff'},
                   {id:'GW 52',loft:'52',shaft:35.25,stiffness:'Stiff'},{id:'SW 54',loft:'54',shaft:35.00,stiffness:'Stiff'},
                   {id:'SW 56',loft:'56',shaft:35.00,stiffness:'Stiff'},{id:'LW 58',loft:'58',shaft:35.00,stiffness:'Stiff'},
                   {id:'LW 60',loft:'60',shaft:35.00,stiffness:'Stiff'},{id:'LW 62',loft:'62',shaft:35.00,stiffness:'Stiff'},
                   {id:'LW 64',loft:'64',shaft:35.00,stiffness:'Stiff'}],
  'Putter':       [{id:'Putter',loft:'3',shaft:34.50,stiffness:'Regular'}],
  'Chipper':      [{id:'Chipper',loft:'35',shaft:35.00,stiffness:'Regular'}]
};

// Club type -> display colour (used in bag list UI)
export const TYPE_COLOR = {
  "Driver":      "#3d7a2e",
  "Fairway Wood":"#2a6a50",
  "Hybrid":      "#2a507a",
  "Iron":        "#5a4a2a",
  "Wedge":       "#6a3a2a",
  "Putter":      "#4a2a6a",
  "Chipper":     "#5a2a4a"
};

// -----------------------------------------------------------------------------
// Ball flight reference data
// Tiers: '0-4' | '5-9' | '10-14' | '15-19' | '20-24' | '25+'  (index 0-5)
// latDisp  = total lateral width (yards) -- divide by 2 for +/- radius
// depShort = how far short a typical bad miss falls (yds)
// depLong  = how far long a typical bad miss flies (yds)
// -----------------------------------------------------------------------------

export const FLIGHT_DATA = {
  tiers: ['0-4','5-9','10-14','15-19','20-24','25+'],
  clubs: {
    'Driver': {
      spinRpm:   [2650, 2870, 3100, 3300, 3520, 3800],
      launchDeg: [11.2, 11.5, 12.0, 12.8, 13.3, 13.8],
      latDisp:   [65,   75,   85,   98,  112,  130],
      depShort:  [15,   18,   22,   28,   32,   38],
      depLong:   [20,   24,   28,   30,   30,   30],
      spinCat:   'Low',
      flight:    'Penetrating with roll-out'
    },
    'Fairway Wood': {
      spinRpm:   [3500, 3900, 4300, 4700, 5100, 5500],
      launchDeg: [13.5, 14.0, 14.5, 15.0, 15.5, 16.0],
      latDisp:   [54,   63,   72,   84,   96,  112],
      depShort:  [12,   15,   18,   22,   26,   30],
      depLong:   [15,   18,   22,   24,   24,   24],
      spinCat:   'Mid',
      flight:    'High arc, moderate roll'
    },
    'Hybrid': {
      spinRpm:   [4000, 4400, 4900, 5300, 5700, 6100],
      launchDeg: [15.5, 16.0, 16.8, 17.5, 18.0, 18.5],
      latDisp:   [44,   52,   60,   70,   82,   96],
      depShort:  [10,   12,   15,   18,   22,   26],
      depLong:   [12,   15,   18,   20,   20,   20],
      spinCat:   'Mid',
      flight:    'High, soft landing'
    },
    'Iron-Long': {
      spinRpm:   [4600, 5000, 5500, 5900, 6400, 6900],
      launchDeg: [16.5, 17.0, 17.8, 18.5, 19.0, 19.5],
      latDisp:   [36,   44,   52,   62,   74,   88],
      depShort:  [10,   12,   15,   18,   22,   26],
      depLong:   [10,   12,   14,   15,   15,   15],
      spinCat:   'Mid',
      flight:    'Penetrating, moderate height'
    },
    'Iron-Mid': {
      spinRpm:   [5600, 6000, 6500, 7000, 7500, 8000],
      launchDeg: [17.5, 18.0, 18.8, 19.5, 20.0, 20.5],
      latDisp:   [28,   34,   40,   50,   62,   76],
      depShort:  [8,    10,   12,   15,   18,   22],
      depLong:   [8,    10,   12,   13,   13,   13],
      spinCat:   'Mid',
      flight:    'Mid-high, checks up'
    },
    'Iron-Short': {
      spinRpm:   [7000, 7500, 8000, 8500, 9000, 9500],
      launchDeg: [22.0, 22.5, 23.0, 23.8, 24.5, 25.0],
      latDisp:   [22,   28,   34,   42,   52,   64],
      depShort:  [6,    8,    10,   12,   15,   18],
      depLong:   [6,    8,    10,   11,   11,   11],
      spinCat:   'High',
      flight:    'High, stops quickly'
    },
    'Wedge': {
      spinRpm:   [8400, 8900, 9400, 9900,10400,10800],
      launchDeg: [25.5, 26.0, 26.8, 27.5, 28.0, 28.5],
      latDisp:   [16,   22,   28,   36,   44,   56],
      depShort:  [5,    6,    8,    10,   12,   16],
      depLong:   [5,    6,    8,    9,    9,    9],
      spinCat:   'High',
      flight:    'Steep descent, holds or spins back'
    },
    'Chipper': {
      spinRpm:   [3000, 3200, 3400, 3600, 3800, 4000],
      launchDeg: [8.0,  8.5,  9.0,  9.5, 10.0, 10.5],
      latDisp:   [12,   16,   20,   26,   32,   40],
      depShort:  [4,    5,    6,    8,   10,   12],
      depLong:   [4,    5,    6,    7,    7,    7],
      spinCat:   'Low',
      flight:    'Low, runs out like a long putt'
    }
  }
};

// Bias lateral offset (yds, +ve = right for RH golfer) and dispersion multiplier
export const BIAS_DATA = {
  'Straight':   { offset:  0, mult: 1.00 },
  'Draw':       { offset: -5, mult: 0.95 },
  'Hook':       { offset:-15, mult: 1.15 },
  'Fade':       { offset: +5, mult: 0.95 },
  'Slice':      { offset:+15, mult: 1.20 },
  'Push Right': { offset:+20, mult: 1.05 },
  'Push Left':  { offset:-20, mult: 1.05 }
};

// -----------------------------------------------------------------------------
// Visualisation constants
// -----------------------------------------------------------------------------

// Colour palette for stacked ellipses (cycles if > 15 clubs)
export const VIZ_COLORS = [
  '#d94030','#3070c0','#28a050','#c07820','#8050c0',
  '#c03080','#20a0a0','#608030','#504090','#a05820',
  '#38b880','#b03050','#6088c0','#a08030','#7a6030'
];

// Path colours (one per shot-path slot: P1, P2, P3)
export const VIZ_PATH_COLORS = ['#d94030','#3070c0','#28a050'];

// Short/long miss probability weights by tier [T0..T5]
// s = probability ball lands short of carry, l = probability ball flies long
export const VIZ_LP = [
  {s:.55,l:.45},{s:.58,l:.42},{s:.62,l:.38},
  {s:.65,l:.35},{s:.68,l:.32},{s:.72,l:.28}
];

// Ellipse tilt and left/right asymmetry factors by shot shape
// td  = tilt degrees (positive = clockwise for RH)
// rf  = right-side inflation factor
// lf  = left-side inflation factor
export const VIZ_ASYM = {
  'Straight':   {td: 8, rf:.10, lf:.05},
  'Draw':       {td: 4, rf:.06, lf:.02},
  'Hook':       {td: 2, rf:.03, lf:.01},
  'Fade':       {td:10, rf:.12, lf:.04},
  'Slice':      {td:14, rf:.15, lf:.08},
  'Push Right': {td: 3, rf:.04, lf:.01},
  'Push Left':  {td:-3, rf:.01, lf:.04}
};

// Left/right miss probability by shot shape
// pl = probability of left miss, pr = probability of right miss
export const VIZ_LPROB = {
  'Straight':   {pl:.45, pr:.55},
  'Draw':       {pl:.55, pr:.45},
  'Hook':       {pl:.65, pr:.35},
  'Fade':       {pl:.35, pr:.65},
  'Slice':      {pl:.25, pr:.75},
  'Push Right': {pl:.25, pr:.75},
  'Push Left':  {pl:.75, pr:.25}
};

// Roll percentage of carry distance by flight key and tier [T0..T5]
// e.g. Driver at T0 (scratch): carry * 0.22 = roll distance
export const VIZ_ROLL = {
  'Driver':      [.22,.20,.18,.16,.14,.12],
  'Fairway Wood':[.13,.12,.10,.09,.08,.07],
  'Hybrid':      [.09,.08,.07,.06,.05,.05],
  'Iron-Long':   [.07,.06,.06,.05,.05,.04],
  'Iron-Mid':    [.05,.05,.04,.04,.03,.03],
  'Iron-Short':  [.03,.03,.03,.02,.02,.02],
  'Wedge':       [.02,.02,.01,.01,.01,.00],
  'Chipper':     [.30,.28,.26,.24,.22,.20]
};
export const BRANDS = ["Callaway","TaylorMade","Titleist","Ping","Mizuno","Cleveland","Cobra","Srixon","Wilson","Bridgestone","PXG","Lazrus","MacGregor","Kirkland","Tour Edge","Custom/Other"];
export const CLUB_TYPES = ["Driver","Fairway Wood","Hybrid","Iron","Wedge","Putter","Chipper"];
export const STIFFNESS = ["Ladies","Senior","Regular","Stiff","X-Stiff","Tour X"];

// =============================================================================
// SHOT TRACKER — Phase 0 additions
// =============================================================================

// SHOT TRACKER — ZONE MAP
// radial_ring: 'bull' | 'inner' | 'outer'
// radial_segment: 0-7 integer, clockwise from 12 o'clock
// 0 = straight/long (top center), 2 = right, 4 = straight/short, 6 = left
// Diagonals: 1 (top-right), 3 (bottom-right), 5 (bottom-left), 7 (top-left)

export const ZONE_SEGMENT_LABELS = [
  'Straight/Long', 'Long Right', 'Right',
  'Short Right',   'Straight/Short', 'Short Left',
  'Left',          'Long Left'
];

// Segment centroids as [angleDeg] from top-center, clockwise
// Used for ellipse fitting and scatter dot placement
export const ZONE_SEGMENT_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

// Ring radius ratios relative to SVG viewBox (300x300, center 150,150)
export const ZONE_RING_RADII = {
  bull:  30,   // bullseye circle radius
  inner: 90,   // inner ring outer radius
  outer: 140   // outer ring outer radius
};

// SHOT TRACKER — FLIGHT PATH
export const FLIGHT_PATHS = [
  { value: 'straight',      label: 'Straight' },
  { value: 'left-to-right', label: 'Left to Right' },
  { value: 'right-to-left', label: 'Right to Left' }
];

// SHOT TRACKER — LIE OPTIONS
// Order matches strokes gained methodology
// 'green' substitutes 'fairway' in Approach mode
export const LIE_OPTIONS = [
  { value: 'tee',      label: 'Tee' },
  { value: 'fairway',  label: 'Fairway' },
  { value: 'rough',    label: 'Rough' },
  { value: 'sand',     label: 'Sand' },
  { value: 'recovery', label: 'Recovery' }
];

export const LIE_OPTIONS_APPROACH = [
  { value: 'green',    label: 'Green' },
  { value: 'rough',    label: 'Rough' },
  { value: 'sand',     label: 'Sand' },
  { value: 'recovery', label: 'Recovery' }
];

// SHOT TRACKER — SHOT MODES (live round only)
export const SHOT_MODES = [
  { value: 'standard', label: 'Standard' },
  { value: 'approach', label: 'Approach' },
  { value: 'on_green', label: 'On Green' }
];

// SHOT TRACKER — RING PERCENTAGE DEFAULTS
// Used to derive synthetic yardage from zone selections
// Tier 0-1 = scratch/low, Tier 2-3 = mid, Tier 4-5 = high
export const RING_PCT_DEFAULTS = [
  { tier: 'pro', inner: 0.95, bull: 1.00, outer: 1.05 },
  { tier: 'low', inner: 0.90, bull: 1.00, outer: 1.10 },
  { tier: 'mid', inner: 0.85, bull: 1.00, outer: 1.15 }
];

// SHOT TRACKER — SESSION TYPES
export const SESSION_TYPES = {
  RANGE:     'range',
  LIVE:      'live',
  AI_CADDIE: 'ai-caddie',
  MANUAL:    'manual'
};

// Session ID generator
// Format: {YYYYMMDDTHHmmss}-{type}-{4_random_chars}
export function generateSessionId(type) {
  var now = new Date();
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  var dt = now.getFullYear().toString()
    + pad(now.getMonth() + 1)
    + pad(now.getDate())
    + 'T' + pad(now.getHours())
    + pad(now.getMinutes())
    + pad(now.getSeconds());
  var rand = Math.random().toString(36).slice(2, 6);
  return dt + '-' + type + '-' + rand;
}

// =============================================================================
// STROKES GAINED \u2014 Phase 4b
// Source: PGA Tour baseline expected strokes by lie and distance
// Tee/Fairway/Rough/Sand/Recovery: distance in yards
// Green (putting): distance in feet
// Lookup via sgExpected() \u2014 uses linear interpolation between entries
// =============================================================================

export const SG_TABLE = {
  tee: [
    {maxDist:100,expected:2.92},{maxDist:120,expected:2.99},{maxDist:140,expected:2.97},
    {maxDist:160,expected:2.99},{maxDist:180,expected:3.05},{maxDist:200,expected:3.12},
    {maxDist:220,expected:3.17},{maxDist:240,expected:3.25},{maxDist:260,expected:3.45},
    {maxDist:280,expected:3.65},{maxDist:300,expected:3.71},{maxDist:320,expected:3.79},
    {maxDist:340,expected:3.86},{maxDist:360,expected:3.92},{maxDist:380,expected:3.96},
    {maxDist:400,expected:3.99},{maxDist:420,expected:4.02},{maxDist:440,expected:4.08},
    {maxDist:460,expected:4.17},{maxDist:480,expected:4.28},{maxDist:500,expected:4.41},
    {maxDist:520,expected:4.54},{maxDist:540,expected:4.65},{maxDist:560,expected:4.74},
    {maxDist:580,expected:4.79},{maxDist:600,expected:4.82}
  ],
  fairway: [
    {maxDist:10,expected:2.18},{maxDist:20,expected:2.40},{maxDist:30,expected:2.52},
    {maxDist:40,expected:2.60},{maxDist:50,expected:2.66},{maxDist:60,expected:2.70},
    {maxDist:70,expected:2.72},{maxDist:80,expected:2.75},{maxDist:90,expected:2.77},
    {maxDist:100,expected:2.80},{maxDist:120,expected:2.85},{maxDist:140,expected:2.91},
    {maxDist:160,expected:2.98},{maxDist:180,expected:3.08},{maxDist:200,expected:3.19},
    {maxDist:220,expected:3.32},{maxDist:240,expected:3.45},{maxDist:260,expected:3.58},
    {maxDist:280,expected:3.69},{maxDist:300,expected:3.78},{maxDist:320,expected:3.84},
    {maxDist:340,expected:3.88},{maxDist:360,expected:3.95},{maxDist:380,expected:4.03},
    {maxDist:400,expected:4.11},{maxDist:420,expected:4.19},{maxDist:440,expected:4.27},
    {maxDist:460,expected:4.34},{maxDist:480,expected:4.42},{maxDist:500,expected:4.50},
    {maxDist:520,expected:4.58},{maxDist:540,expected:4.66},{maxDist:560,expected:4.74},
    {maxDist:580,expected:4.82},{maxDist:600,expected:4.89}
  ],
  rough: [
    {maxDist:10,expected:2.34},{maxDist:20,expected:2.59},{maxDist:30,expected:2.70},
    {maxDist:40,expected:2.78},{maxDist:50,expected:2.87},{maxDist:60,expected:2.91},
    {maxDist:70,expected:2.93},{maxDist:80,expected:2.96},{maxDist:90,expected:2.99},
    {maxDist:100,expected:3.02},{maxDist:120,expected:3.08},{maxDist:140,expected:3.15},
    {maxDist:160,expected:3.23},{maxDist:180,expected:3.31},{maxDist:200,expected:3.42},
    {maxDist:220,expected:3.53},{maxDist:240,expected:3.64},{maxDist:260,expected:3.74},
    {maxDist:280,expected:3.83},{maxDist:300,expected:3.90},{maxDist:320,expected:3.95},
    {maxDist:340,expected:4.02},{maxDist:360,expected:4.11},{maxDist:380,expected:4.21},
    {maxDist:400,expected:4.30},{maxDist:420,expected:4.40},{maxDist:440,expected:4.49},
    {maxDist:460,expected:4.58},{maxDist:480,expected:4.68},{maxDist:500,expected:4.77},
    {maxDist:520,expected:4.87},{maxDist:540,expected:4.96},{maxDist:560,expected:5.06},
    {maxDist:580,expected:5.15},{maxDist:600,expected:5.25}
  ],
  sand: [
    {maxDist:10,expected:2.43},{maxDist:20,expected:2.53},{maxDist:30,expected:2.66},
    {maxDist:40,expected:2.82},{maxDist:50,expected:2.92},{maxDist:60,expected:3.15},
    {maxDist:70,expected:3.21},{maxDist:80,expected:3.24},{maxDist:90,expected:3.24},
    {maxDist:100,expected:3.23},{maxDist:120,expected:3.21},{maxDist:140,expected:3.22},
    {maxDist:160,expected:3.28},{maxDist:180,expected:3.40},{maxDist:200,expected:3.55},
    {maxDist:220,expected:3.70},{maxDist:240,expected:3.84},{maxDist:260,expected:3.93},
    {maxDist:280,expected:4.00},{maxDist:300,expected:4.04},{maxDist:320,expected:4.12},
    {maxDist:340,expected:4.26},{maxDist:360,expected:4.41},{maxDist:380,expected:4.55},
    {maxDist:400,expected:4.69},{maxDist:420,expected:4.83},{maxDist:440,expected:4.97},
    {maxDist:460,expected:5.11},{maxDist:480,expected:5.25},{maxDist:500,expected:5.40},
    {maxDist:520,expected:5.54},{maxDist:540,expected:5.68},{maxDist:560,expected:5.82},
    {maxDist:580,expected:5.96},{maxDist:600,expected:6.10}
  ],
  recovery: [
    {maxDist:10,expected:3.45},{maxDist:20,expected:3.51},{maxDist:30,expected:3.57},
    {maxDist:40,expected:3.71},{maxDist:50,expected:3.79},{maxDist:60,expected:3.83},
    {maxDist:70,expected:3.84},{maxDist:80,expected:3.84},{maxDist:90,expected:3.82},
    {maxDist:100,expected:3.80},{maxDist:120,expected:3.78},{maxDist:140,expected:3.80},
    {maxDist:160,expected:3.81},{maxDist:180,expected:3.82},{maxDist:200,expected:3.87},
    {maxDist:220,expected:3.92},{maxDist:240,expected:3.97},{maxDist:260,expected:4.03},
    {maxDist:280,expected:4.10},{maxDist:300,expected:4.20},{maxDist:320,expected:4.31},
    {maxDist:340,expected:4.44},{maxDist:360,expected:4.56},{maxDist:380,expected:4.66},
    {maxDist:400,expected:4.75},{maxDist:420,expected:4.84},{maxDist:440,expected:4.94},
    {maxDist:460,expected:5.03},{maxDist:480,expected:5.13},{maxDist:500,expected:5.22},
    {maxDist:520,expected:5.32},{maxDist:540,expected:5.41},{maxDist:560,expected:5.51},
    {maxDist:580,expected:5.60},{maxDist:600,expected:5.70}
  ],
  /* green: distance in feet (user entry and table both in feet) */
  green: [
    {maxDist:3,expected:1.04},{maxDist:4,expected:1.13},{maxDist:5,expected:1.23},
    {maxDist:6,expected:1.34},{maxDist:7,expected:1.42},{maxDist:8,expected:1.50},
    {maxDist:9,expected:1.56},{maxDist:10,expected:1.61},{maxDist:15,expected:1.78},
    {maxDist:20,expected:1.87},{maxDist:30,expected:1.98},{maxDist:40,expected:2.06},
    {maxDist:50,expected:2.14},{maxDist:60,expected:2.21},{maxDist:90,expected:2.40}
  ]
};

// Returns expected strokes from a given lie and distance using linear interpolation.
// lie: key in SG_TABLE. distance: yards for all lies except 'green' (feet).
// Returns null if lie unknown, distance invalid, or table empty.
export function sgExpected(lie, distance) {
  var tbl = SG_TABLE[lie];
  if (!tbl || !tbl.length) return null;
  var dist = Number(distance);
  if (isNaN(dist) || dist < 0) return null;
  /* Below minimum -- return first entry */
  if (dist <= tbl[0].maxDist) return tbl[0].expected;
  /* Beyond maximum -- return last entry */
  if (dist >= tbl[tbl.length - 1].maxDist) return tbl[tbl.length - 1].expected;
  /* Linear interpolation between surrounding entries */
  for (var i = 1; i < tbl.length; i++) {
    if (dist <= tbl[i].maxDist) {
      var lo = tbl[i - 1], hi = tbl[i];
      var t = (dist - lo.maxDist) / (hi.maxDist - lo.maxDist);
      return parseFloat((lo.expected + t * (hi.expected - lo.expected)).toFixed(4));
    }
  }
  return tbl[tbl.length - 1].expected;
}
