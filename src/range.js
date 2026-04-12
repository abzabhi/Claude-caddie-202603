/**
 * range.js  -  Range Session tab for Gordy the Virtual Caddy.
 * Rules: no Unicode literals (\uXXXX only), all onclick fns on window,
 * old code commented not deleted, strict mode via type="module".
 * NOTE: distance type stored in range sessions is carry (not total yardage).
 */

import { bag, rangeSessions, save, removeRangeSession } from './store.js';
import {
  generateSessionId, SESSION_TYPES,
  ZONE_SEGMENT_LABELS, ZONE_RING_RADII,
  FLIGHT_PATHS, VIZ_COLORS
} from './constants.js';
import { deriveStats, fmtDate } from './geo.js';

function _localISO() { var n=new Date(),p=function(x){return x<10?'0'+x:''+x;}; return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+'T'+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds()); }

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

var _rangeState     = null;
var _sessionStart   = 0;
var _editingIndex   = null;
var _pendingRing    = null;
var _pendingSegment = null;
var _pendingFlight  = 'straight';
// var _fwYds       = 35; // removed  -  fairway width input removed per 2026-04-08 rebuild
var _startClubId        = null; // tracks selection on start screen before session begins
var _selectedSummaryKey = null; // key = clubId + '|' + yardage; null = show all shots

window._rangeState = null;
// window._rangeEllipseActive = false; // removed  -  Show in Viz toggle removed per 2026-04-08 rebuild

// -----------------------------------------------------------------------------
// SVG helpers
// -----------------------------------------------------------------------------

function _pt(cx, cy, r, angleDeg) {
  var rad = angleDeg * Math.PI / 180;
  return { x: +(cx + r * Math.sin(rad)).toFixed(3), y: +(cy - r * Math.cos(rad)).toFixed(3) };
}

function _arcPath(cx, cy, r1, r2, startDeg, endDeg) {
  var s1 = _pt(cx, cy, r2, startDeg), e1 = _pt(cx, cy, r2, endDeg);
  var s2 = _pt(cx, cy, r1, endDeg),   e2 = _pt(cx, cy, r1, startDeg);
  return 'M '+s1.x+' '+s1.y+' A '+r2+' '+r2+' 0 0 1 '+e1.x+' '+e1.y+
         ' L '+s2.x+' '+s2.y+' A '+r1+' '+r1+' 0 0 0 '+e2.x+' '+e2.y+' Z';
}

// Build shot counts keyed by zone for summary radial
function _calcShotCounts(shots) {
  var counts = {}, max = 0;
  shots.forEach(function(s) {
    var k = s.radial_ring === 'bull' ? 'bull' : s.radial_ring + '-' + s.radial_segment;
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > max) max = counts[k];
  });
  return { counts: counts, max: max };
}

/**
 * Build the radial SVG.
 * @param {string|null}  selRing     Selected ring (interactive mode) or null
 * @param {number|null}  selSeg      Selected segment or null
 * @param {boolean}      isStatic    No click handlers (summary/heat mode)
 * @param {object|null}  heatCounts  Zone count map for summary heat colouring
 * @param {number}       heatMax     Max count for normalisation
 */
function _buildRadialSVG(selRing, selSeg, isStatic, heatCounts, heatMax) {
  var cx = 150, cy = 150;
  var rB = ZONE_RING_RADII.bull, rI = ZONE_RING_RADII.inner, rO = ZONE_RING_RADII.outer;

  // Fixed two-toned background  -  both interactive and static modes.
  // Center strip: 60px either side of cx = 120px total width.
  // Old fairway-calculation removed per 2026-04-08 rebuild:
  //   var fwHalf = (_fwYds / 2) * (rI / 17.5);
  //   var fwL = (cx - fwHalf).toFixed(1); var fwW = (fwHalf * 2).toFixed(1);
  //   bg varied by isStatic  -  fairway strip only shown in interactive mode.
  var bg = '<rect width="300" height="300" fill="#6a9a50"/>' +
           '<rect x="90" y="0" width="120" height="300" fill="#9ec880"/>';

  var paths = '';

  // Heat fill: red-based, darker = more shots
  function _heatR(count) {
    if (!heatMax || !count) return 'rgba(255,255,255,0.12)';
    var a = (0.18 + (count / heatMax) * 0.72).toFixed(2);
    return 'rgba(160,30,30,' + a + ')';
  }

  // 8 inner segments
  for (var i = 0; i < 8; i++) {
    var isSel = (!heatCounts && selRing === 'inner' && selSeg === i);
    var fill  = heatCounts ? _heatR(heatCounts['inner-' + i] || 0)
                           : isSel ? 'rgba(180,30,30,0.45)' : 'rgba(255,255,255,0.18)';
    var strk  = isSel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
    var sw    = isSel ? '2.5' : '1.5';
    var d     = _arcPath(cx, cy, rB, rI, (i * 45) - 22.5, (i * 45) + 22.5);
    var h     = isStatic ? '' : ' onclick="rangeZoneTap(\'inner\',' + i + ')" style="cursor:pointer;touch-action:manipulation"';
    paths += '<path id="zone-' + i + '-inner" d="' + d + '" fill="' + fill + '" stroke="' + strk + '" stroke-width="' + sw + '"' + h + '></path>';
  }

  // 8 outer segments
  for (var j = 0; j < 8; j++) {
    var isSel2 = (!heatCounts && selRing === 'outer' && selSeg === j);
    var fill2  = heatCounts ? _heatR(heatCounts['outer-' + j] || 0)
                            : isSel2 ? 'rgba(180,30,30,0.25)' : 'rgba(255,255,255,0.18)';
    var strk2  = isSel2 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
    var sw2    = isSel2 ? '2.5' : '1.5';
    var d2     = _arcPath(cx, cy, rI, rO, (j * 45) - 22.5, (j * 45) + 22.5);
    var h2     = isStatic ? '' : ' onclick="rangeZoneTap(\'outer\',' + j + ')" style="cursor:pointer;touch-action:manipulation"';
    paths += '<path id="zone-' + j + '-outer" d="' + d2 + '" fill="' + fill2 + '" stroke="' + strk2 + '" stroke-width="' + sw2 + '"' + h2 + '></path>';
  }

  // Bullseye
  var bullSel  = (!heatCounts && selRing === 'bull');
  var bullFill = heatCounts ? _heatR(heatCounts['bull'] || 0)
                            : bullSel ? 'rgba(180,30,30,0.85)' : 'rgba(255,255,255,0.18)';
  var bullStrk = bullSel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
  var bullSW   = bullSel ? '2.5' : '1.5';
  var bullH    = isStatic ? '' : ' onclick="rangeZoneTap(\'bull\',null)" style="cursor:pointer;touch-action:manipulation"';
  paths += '<circle id="zone-bull" cx="150" cy="150" r="' + rB + '" fill="' + bullFill + '" stroke="' + bullStrk + '" stroke-width="' + bullSW + '"' + bullH + '></circle>';

  // Zone percentage labels  -  static/heat mode only, shown where count > 0
  var labels = '';
  if (isStatic && heatCounts) {
    var lTotal = 0;
    Object.keys(heatCounts).forEach(function(k) { lTotal += heatCounts[k]; });
    if (lTotal > 0) {
      var innerMidR = (rB + rI) / 2;  // 60
      var outerMidR = (rI + rO) / 2;  // 115
      var bullCnt = heatCounts['bull'] || 0;
      if (bullCnt > 0) {
        var bullPct = Math.round(bullCnt / lTotal * 100);
        labels += '<text x="150" y="154" font-family="monospace" font-size="9" fill="white" text-anchor="middle">' + bullPct + '%</text>';
      }
      for (var li = 0; li < 8; li++) {
        var liCnt = heatCounts['inner-' + li] || 0;
        if (liCnt > 0) {
          var liPct = Math.round(liCnt / lTotal * 100);
          var liAng = li * 45 * Math.PI / 180;
          var liX   = (cx + innerMidR * Math.sin(liAng)).toFixed(1);
          var liY   = (cy - innerMidR * Math.cos(liAng) + 3).toFixed(1);
          labels += '<text x="' + liX + '" y="' + liY + '" font-family="monospace" font-size="9" fill="white" text-anchor="middle">' + liPct + '%</text>';
        }
      }
      for (var lj = 0; lj < 8; lj++) {
        var ljCnt = heatCounts['outer-' + lj] || 0;
        if (ljCnt > 0) {
          var ljPct = Math.round(ljCnt / lTotal * 100);
          var ljAng = lj * 45 * Math.PI / 180;
          var ljX   = (cx + outerMidR * Math.sin(ljAng)).toFixed(1);
          var ljY   = (cy - outerMidR * Math.cos(ljAng) + 3).toFixed(1);
          labels += '<text x="' + ljX + '" y="' + ljY + '" font-family="monospace" font-size="9" fill="white" text-anchor="middle">' + ljPct + '%</text>';
        }
      }
    }
  }

  // Zone selection label  -  interactive mode only
  var zoneDiv = '';
  if (!isStatic) {
    var zlText = '\u2014';
    if (selRing === 'bull') { zlText = 'Bull'; }
    else if (selRing && selSeg !== null && selSeg !== undefined) {
      zlText = (selRing === 'inner' ? 'Inner' : 'Outer') + ' \u00B7 ' + ZONE_SEGMENT_LABELS[selSeg];
    }
    zoneDiv = '<div style="text-align:center;font-size:.68rem;color:var(--tx2);margin-top:6px">' + zlText + '</div>';
  }

  return '<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"' +
    ' style="width:100%;max-width:300px;display:block;margin:0 auto">' +
    bg + paths + labels + '</svg>' + zoneDiv;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _activeBag() { return bag.filter(function(c) { return c.tested === true && c.type !== 'Putter'; }); }

function _clubName(id) {
  var c = bag.find(function(x) { return x.id === id; });
  return c ? (c.identifier || c.type || 'Club') : '(unknown)';
}

function _clubAvgYds(c) {
  var st = deriveStats(c.sessions);
  return st ? Math.round((st.avgMin + st.avgMax) / 2) : null;
}

function _flightLabel(val) {
  var fp = FLIGHT_PATHS.find(function(f) { return f.value === val; });
  return fp ? fp.label : val;
}

function _ringLabel(ring) {
  return ring === 'bull' ? 'Bull' : ring === 'inner' ? 'Inner' : 'Outer';
}

// -----------------------------------------------------------------------------
// Club shelf (unified for start + shot screens, single-select)
// -----------------------------------------------------------------------------

function _renderClubShelf(activeId) {
  var clubs = _activeBag();
  if (!clubs.length) return '<div style="font-size:.65rem;color:var(--tx3)">No active clubs in bag.</div>';
  return '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
    clubs.map(function(c, i) {
      var on  = c.id === activeId;
      var avg = _clubAvgYds(c);
      return '<label onclick="rangeSelectClub(\'' + c.id + '\')" id="rngClub-' + c.id + '"' +
        ' style="display:flex;align-items:center;gap:5px;padding:4px 9px;' +
        'background:' + (on ? 'var(--gr3)' : 'var(--bg)') + ';' +
        'border:1px solid ' + (on ? 'var(--gr2)' : 'var(--br)') + ';' +
        'border-radius:4px;cursor:pointer;font-size:.66rem;transition:all .15s">' +
        '<div style="width:8px;height:8px;border-radius:2px;background:' + VIZ_COLORS[i % VIZ_COLORS.length] + ';flex-shrink:0"></div>' +
        (c.identifier || c.type) +
        (avg ? ' <span style="color:var(--tx3);font-size:.58rem">' + avg + 'y</span>' : '') +
        '</label>';
    }).join('') + '</div>';
}

// -----------------------------------------------------------------------------
// _buildClubSummary  -  shared aggregation, called live and at commit.
// Returns clubSummary[] per spec section 2h.
// NOTE: distance type is carry (not total yardage).
// -----------------------------------------------------------------------------

function _buildClubSummary(shots) {
  // Group shots by clubId + yardage
  var groups = {};
  shots.forEach(function(s) {
    var yds = s.yardage || 0;
    var key = s.clubId + '|' + yds;
    if (!groups[key]) { groups[key] = { clubId: s.clubId, yardage: yds, shots: [] }; }
    groups[key].shots.push(s);
  });

  // Accumulate into per-club structure
  var clubMap = {};
  Object.keys(groups).forEach(function(key) {
    var g   = groups[key];
    var cid = g.clubId;
    if (!clubMap[cid]) { clubMap[cid] = { clubId: cid, clubName: _clubName(cid), targets: [] }; }

    // Initialise dispersion structure with all 8 segments
    var disp = {
      bull:  { total: 0, flightPaths: { straight: 0, 'left-to-right': 0, 'right-to-left': 0 } },
      inner: {},
      outer: {}
    };
    for (var seg = 0; seg < 8; seg++) {
      disp.inner[seg] = { total: 0, flightPaths: { straight: 0, 'left-to-right': 0, 'right-to-left': 0 } };
      disp.outer[seg] = { total: 0, flightPaths: { straight: 0, 'left-to-right': 0, 'right-to-left': 0 } };
    }

    g.shots.forEach(function(s) {
      var fp = s.flight_path || 'straight';
      if (s.radial_ring === 'bull') {
        disp.bull.total++;
        if (disp.bull.flightPaths[fp] !== undefined) { disp.bull.flightPaths[fp]++; }
      } else if (s.radial_ring === 'inner') {
        var iseg = +s.radial_segment;
        if (disp.inner[iseg]) {
          disp.inner[iseg].total++;
          if (disp.inner[iseg].flightPaths[fp] !== undefined) { disp.inner[iseg].flightPaths[fp]++; }
        }
      } else if (s.radial_ring === 'outer') {
        var oseg = +s.radial_segment;
        if (disp.outer[oseg]) {
          disp.outer[oseg].total++;
          if (disp.outer[oseg].flightPaths[fp] !== undefined) { disp.outer[oseg].flightPaths[fp]++; }
        }
      }
    });

    clubMap[cid].targets.push({ yardage: g.yardage, shotCount: g.shots.length, dispersion: disp });
  });

  return Object.keys(clubMap).map(function(cid) { return clubMap[cid]; });
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

function _renderStartScreen() {
  var clubs  = _activeBag();
  var initId = _startClubId || (clubs[0] && clubs[0].id);
  return (
    '<div class="collapsible-hdr" onclick="_rangeToggleClubs()" id="rangeClubHdr">Clubs \u25BC</div>' +
    '<div id="rangeClubBody" style="padding:8px 0 10px">' + _renderClubShelf(initId) + '</div>' +
    '<div class="card">' +
      '<div class="card-title">Start Range Session</div>' +
      '<div style="font-size:.65rem;color:var(--tx3);margin-bottom:10px">Select a club above, then start.</div>' +
      '<button class="rbtn" onclick="rangeStartSession()">Start Session</button>' +
    '</div>'
  );
}

function _shotRowHtml(shot, idx, editingIdx) {
  var zone = shot.radial_ring === 'bull'
    ? 'Bull'
    : _ringLabel(shot.radial_ring) + ' \u00B7 ' + (ZONE_SEGMENT_LABELS[shot.radial_segment] || '');
  var yds  = shot.yardage ? shot.yardage + 'yd ' : '';
  var isEd = (editingIdx === idx);
  var row  = '<div class="hist-item" id="rangeShot-' + idx + '" style="flex-direction:column;align-items:stretch">' +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:.68rem">Shot\u00A0' + (idx + 1) + ' \u00B7 ' + _clubName(shot.clubId) +
        ' \u00B7 ' + yds + zone + ' \u00B7 ' + _flightLabel(shot.flight_path) + '</span>' +
      '<span style="display:flex;gap:5px;flex-shrink:0">' +
        '<button class="btn sec" style="font-size:.56rem;padding:2px 6px" onclick="rangeEditShot(' + idx + ')">' + (isEd ? 'Cancel' : 'Edit') + '</button>' +
        '<button class="btn" style="font-size:.56rem;padding:2px 6px;background:var(--danger);color:white;border-color:var(--danger)" onclick="rangeDeleteShot(' + idx + ')">\u2715</button>' +
      '</span>' +
    '</div>';
  if (isEd) { row += _renderEditForm(shot, idx); }
  return row + '</div>';
}

function _renderEditForm(shot, idx) {
  var clubs    = _activeBag();
  var clubOpts = clubs.map(function(c) {
    return '<option value="' + c.id + '"' + (c.id === shot.clubId ? ' selected' : '') + '>' + (c.identifier || c.type) + '</option>';
  }).join('');
  var fpBtns = FLIGHT_PATHS.map(function(fp) {
    return '<button class="implied-tog' + (shot.flight_path === fp.value ? ' on' : '') + '"' +
      ' id="rangeEditFp-' + idx + '-' + fp.value + '"' +
      ' onclick="rangeEditFlightSelect(\'' + fp.value + '\',' + idx + ')">' + fp.label + '</button>';
  }).join('');
  var curZone = shot.radial_ring === 'bull' ? 'Bull'
    : _ringLabel(shot.radial_ring) + ' \u00B7 ' + (ZONE_SEGMENT_LABELS[shot.radial_segment] || '');
  return '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--br)">' +
    '<div class="field"><div class="flbl">Club</div><select id="rangeEditClub-' + idx + '">' + clubOpts + '</select></div>' +
    '<div class="field"><div class="flbl">Target (yds)</div>' +
      '<input type="number" inputmode="numeric" id="rangeEditYds-' + idx + '" value="' + (shot.yardage || '') + '" style="width:90px"></div>' +
    '<div style="font-size:.62rem;color:var(--tx3);margin-bottom:6px">Zone: ' + curZone + '</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' + fpBtns + '</div>' +
    '<button class="rbtn" onclick="rangeSaveEdit(' + idx + ')">Save</button>' +
    '</div>';
}

function _renderShotLog(editingIdx) {
  if (!_rangeState || !_rangeState.shots.length) {
    return '<div class="hist-empty">No shots yet \u2014 log your first shot above.</div>';
  }
  return _rangeState.shots.map(function(s, i) { return _shotRowHtml(s, i, editingIdx); }).join('');
}

// Session Summary  -  live, collapsible, single-select row drives distribution radial
function _renderSessionSummary() {
  if (!_rangeState || !_rangeState.shots.length) return '';
  var summary = _buildClubSummary(_rangeState.shots);
  var rows = '';
  summary.forEach(function(clubEntry) {
    clubEntry.targets.forEach(function(target) {
      var key      = clubEntry.clubId + '|' + target.yardage;
      var isOn     = (_selectedSummaryKey === key);
      var total    = target.shotCount;
      var bullCnt  = target.dispersion.bull.total;
      var innerCnt = 0, outerCnt = 0;
      for (var seg = 0; seg < 8; seg++) {
        innerCnt += target.dispersion.inner[seg].total;
        outerCnt += target.dispersion.outer[seg].total;
      }
      var pct = function(n) { return total ? Math.round(n / total * 100) + '%' : '0%'; };
      rows += '<div class="hist-item" data-key="' + key + '"' +
        ' onclick="_rangeSummarySelect(\'' + key + '\')"' +
        ' style="cursor:pointer;' + (isOn ? 'background:var(--gr3);border-color:var(--gr2)' : '') + '">' +
        '<div style="font-size:.68rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">' +
          '<span>' + _clubName(clubEntry.clubId) + ' \u00B7 ' + target.yardage + ' yds</span>' +
          '<span style="color:var(--tx3)">Bull ' + pct(bullCnt) + ' / Inner ' + pct(innerCnt) + ' / Outer ' + pct(outerCnt) + '</span>' +
        '</div>' +
        '</div>';
    });
  });
  return (
    '<div class="collapsible-hdr" onclick="_rangeToggleSummary()" id="rangeSummaryHdr">Session Summary \u25BC</div>' +
    '<div id="rangeSummaryBody" style="padding:4px 0">' + rows + '</div>'
  );
}

// Shot Distribution  -  static heat radial, driven by _selectedSummaryKey
function _renderSummarySection() {
  if (!_rangeState || !_rangeState.shots.length) return '';
  var shots = _rangeState.shots;
  if (_selectedSummaryKey) {
    var parts         = _selectedSummaryKey.split('|');
    var filterClubId  = parts[0];
    var filterYardage = parseInt(parts[1], 10);
    shots = shots.filter(function(s) {
      return s.clubId === filterClubId && (s.yardage || 0) === filterYardage;
    });
  }
  var data = _calcShotCounts(shots);
  return (
    '<div class="collapsible-hdr" onclick="_rangeToggleDist()" id="rangeDistHdr">Shot Distribution \u25BC</div>' +
    '<div id="rangeDistBody" style="padding:8px 0">' +
      _buildRadialSVG(null, null, true, data.counts, data.max) +
    '</div>'
    // Removed per 2026-04-08 rebuild  -  Show in Viz toggle:
    // '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' +
    //   '<span class="slbl">Show in Viz</span>' +
    //   '<button class="implied-tog..." id="rangeEllipseToggle" onclick="rangeToggleEllipse()">...</button>' +
    // '</div>'
  );
}

function _renderShotScreen() {
  var activeId  = _rangeState.clubId;
  var shotCount = _rangeState.shots.length;

  var fpBtns = FLIGHT_PATHS.map(function(fp) {
    return '<button class="implied-tog' + (fp.value === _pendingFlight ? ' on' : '') + '"' +
      ' id="rangeFp-' + fp.value + '" onclick="rangeFlightSelect(\'' + fp.value + '\')">' + fp.label + '</button>';
  }).join('');

  // Removed per 2026-04-08 rebuild  -  standalone Target card (was between club shelf and Shot Result):
  // '<div class="card" style="margin-bottom:10px"><div class="card-title">Target</div>...'
  // Also removed: large yardage display div, fairway width input row (both were inside Shot Result card).
  // Target is now a compact inline row at the top of the Shot Result card.

  return (
    // Club shelf (collapsible)
    '<div class="collapsible-hdr" onclick="_rangeToggleClubs()" id="rangeClubHdr">Clubs \u25BC</div>' +
    '<div id="rangeClubBody" style="padding:8px 0 10px">' + _renderClubShelf(activeId) + '</div>' +

    // Shot Result card
    '<div class="card" style="margin-bottom:10px">' +
      '<div class="card-title">Shot Result</div>' +
      // Compact inline target  -  label + input + unit on one line
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">' +
        '<span style="font-size:.68rem;color:var(--tx2)">Target</span>' +
        '<input type="number" inputmode="numeric" id="rangeTargetInput"' +
        ' value="' + (_rangeState.targetYardage || '') + '" style="width:80px"' +
        ' onchange="rangeSetTarget(this.value)">' +
        '<span style="font-size:.68rem;color:var(--tx3)">yds</span>' +
      '</div>' +
      // Radial SVG (zone selection label generated inside _buildRadialSVG)
      '<div id="rangeSvgWrap">' + _buildRadialSVG(_pendingRing, _pendingSegment, false) + '</div>' +
      // Flight path buttons
      '<div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">' + fpBtns + '</div>' +
      // Record + error
      '<button class="rbtn" onclick="rangeRecordShot()">\uD83C\uDFAF Record Shot</button>' +
      '<div id="rangeRecordErr" style="display:none;font-size:.65rem;color:var(--danger);margin-top:6px"></div>' +
    '</div>' +

    // Session log (collapsible)
    '<div class="collapsible-hdr" onclick="_rangeToggleLog()" id="rangeLogHdr">Session Log (' + shotCount + ') \u25BC</div>' +
    '<div id="rangeLogBody">' +
      '<div id="rangeShotLog">' + _renderShotLog(null) + '</div>' +
    '</div>' +

    // Session Summary (collapsible)  -  live, single-select drives distribution radial
    _renderSessionSummary() +

    // Shot Distribution (collapsible)  -  heat map, selection-driven
    _renderSummarySection() +

    // Actions
    (shotCount ? '<button class="rbtn" onclick="rangeCommit()" style="margin-top:12px">Commit Session</button>' : '') +
    '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);width:100%;margin-top:8px" onclick="rangeDiscard()">Discard Session</button>'
  );
}

function _renderCommitScreen() {
  var shots  = _rangeState.shots, total = shots.length;
  var pct    = function(n) { return total ? Math.round(n / total * 100) : 0; };
  var bulls  = shots.filter(function(s) { return s.radial_ring === 'bull'; }).length;
  var inners = shots.filter(function(s) { return s.radial_ring === 'inner'; }).length;
  var outers = shots.filter(function(s) { return s.radial_ring === 'outer'; }).length;
  var fpLines = FLIGHT_PATHS.map(function(fp) {
    return fp.label + ': ' + pct(shots.filter(function(s) { return s.flight_path === fp.value; }).length) + '%';
  }).join(' / ');
  return (
    '<div class="card" style="margin-bottom:10px">' +
      '<div class="card-title">Session Summary</div>' +
      '<div style="font-size:.72rem;color:var(--tx2);line-height:2">' +
        'Total shots: ' + total + '<br>' +
        'Club: ' + _clubName(_rangeState.clubId) + '<br>' +
        'Zone: Bull ' + pct(bulls) + '% / Inner ' + pct(inners) + '% / Outer ' + pct(outers) + '%<br>' +
        'Flight: ' + fpLines +
      '</div>' +
    '</div>' +
    '<button class="rbtn" onclick="_rangeConfirmCommit()" style="margin-bottom:8px">Confirm &amp; Save</button>' +
    '<button class="btn sec" onclick="rangeInit()" style="width:100%">Back</button>'
  );
}

function _renderRoot(html) {
  var root = document.getElementById('rangeRoot');
  if (root) root.innerHTML = html;
}

// -----------------------------------------------------------------------------
// Core functions
// -----------------------------------------------------------------------------

function rangeInit() {
  _selectedSummaryKey = null;
  if (!_rangeState) {
    var raw = localStorage.getItem('gordy:activeRange');
    if (raw) {
      try {
        _rangeState = JSON.parse(raw);
        window._rangeState = _rangeState;
        _sessionStart = _rangeState._sessionStart || Date.now();
      } catch(e) { _rangeState = null; window._rangeState = null; }
    }
  }
  _editingIndex = null;
  if (!_rangeState) {
    var clubs = _activeBag();
    if (!_startClubId && clubs.length) _startClubId = clubs[0].id;
    _renderRoot(_renderStartScreen());
  } else {
    _renderRoot(_renderShotScreen());
  }
}

function rangeStartSession() {
  var clubs  = _activeBag();
  var clubId = _startClubId || (clubs[0] && clubs[0].id);
  if (!clubId) return;
  var now      = Date.now();
  var initClub = clubs.find(function(c) { return c.id === clubId; });
  var initAvg  = initClub ? _clubAvgYds(initClub) : null;
  _rangeState = {
    sessionId:         generateSessionId(SESSION_TYPES.RANGE),
    date:              today().slice(0, 10),
    clubId:            clubId,
    club_bag_snapshot: clubs.map(function(c) { return c.id; }),
    shots:             [],
    committed:         false,
    targetYardage:     initAvg || null,
    _sessionStart:     now
  };
  _sessionStart       = now;
  _pendingRing        = null;
  _pendingSegment     = null;
  _pendingFlight      = 'straight';
  _editingIndex       = null;
  _selectedSummaryKey = null;
  window._rangeState  = _rangeState;
  _rangePersist();
  if (window.updateSessionPill) window.updateSessionPill();
  _renderRoot(_renderShotScreen());
}

// Single-select  -  works on both start screen and active session
function rangeSelectClub(clubId) {
  if (!clubId) return;
  var c   = bag.find(function(x) { return x.id === clubId; });
  var avg = c ? _clubAvgYds(c) : null;
  if (_rangeState) {
    _rangeState.clubId        = clubId;
    _rangeState.targetYardage = avg !== null ? avg : null;
    window._rangeState = _rangeState;
    _rangePersist();
    // Update target input  -  clear if no avg (user must enter manually)
    var inp = document.getElementById('rangeTargetInput');
    if (inp) inp.value = avg !== null ? avg : '';
  } else {
    _startClubId = clubId;
  }
  // Surgical shelf highlight update  -  no full re-render
  _activeBag().forEach(function(cl) {
    var lbl = document.getElementById('rngClub-' + cl.id);
    if (!lbl) return;
    var on = cl.id === clubId;
    lbl.style.background  = on ? 'var(--gr3)' : 'var(--bg)';
    lbl.style.borderColor = on ? 'var(--gr2)' : 'var(--br)';
  });
}

function rangeSetTarget(yards) {
  if (!_rangeState) return;
  _rangeState.targetYardage = (yards === '' || yards === null) ? null : (parseInt(yards, 10) || null);
  window._rangeState = _rangeState;
  _rangePersist();
}

// function rangeSetFairway(val) { ... } // removed per 2026-04-08 rebuild

function rangeZoneTap(ring, seg) {
  _pendingRing    = ring;
  _pendingSegment = (seg === null || seg === undefined) ? null : +seg;
  var wrap = document.getElementById('rangeSvgWrap');
  if (wrap) wrap.innerHTML = _buildRadialSVG(_pendingRing, _pendingSegment, false);
}

function rangeFlightSelect(val) {
  _pendingFlight = val;
  FLIGHT_PATHS.forEach(function(fp) {
    var btn = document.getElementById('rangeFp-' + fp.value);
    if (btn) { if (fp.value === val) btn.classList.add('on'); else btn.classList.remove('on'); }
  });
}

function rangeRecordShot() {
  if (!_rangeState) return;
  var errEl = document.getElementById('rangeRecordErr');
  // Sync target from input first  -  mobile may not fire onchange
  var inp = document.getElementById('rangeTargetInput');
  if (inp && inp.value !== '') _rangeState.targetYardage = parseInt(inp.value, 10) || null;
  if (!_pendingRing) {
    if (errEl) { errEl.textContent = 'Select a zone on the radial first.'; errEl.style.display = 'block'; }
    return;
  }
  if (!_rangeState.targetYardage) {
    if (errEl) { errEl.textContent = 'Enter a target yardage before recording.'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  _rangeState.shots.push({
    sessionId:      _rangeState.sessionId,
    sessionType:    SESSION_TYPES.RANGE,
    clubId:         _rangeState.clubId,
    radial_ring:    _pendingRing,
    radial_segment: _pendingSegment,
    flight_path:    _pendingFlight,
    timestamp:      _localISO(),
    timestampDelta: Math.floor((Date.now() - _sessionStart) / 1000),
    yardage:        _rangeState.targetYardage,
    entryType:      SESSION_TYPES.RANGE
  });
  window._rangeState = _rangeState;
  _rangePersist();
  if (window.updateSessionPill) window.updateSessionPill();

  _pendingRing    = null;
  _pendingSegment = null;
  _editingIndex   = null;
  _renderRoot(_renderShotScreen());
}

function rangeEditShot(index) {
  if (!_rangeState) return;
  _editingIndex = (_editingIndex === index) ? null : index;
  var logEl = document.getElementById('rangeShotLog');
  if (logEl) logEl.innerHTML = _renderShotLog(_editingIndex);
}

function rangeEditFlightSelect(val, idx) {
  FLIGHT_PATHS.forEach(function(fp) {
    var btn = document.getElementById('rangeEditFp-' + idx + '-' + fp.value);
    if (btn) { if (fp.value === val) btn.classList.add('on'); else btn.classList.remove('on'); }
  });
  var clubSel = document.getElementById('rangeEditClub-' + idx);
  if (clubSel) clubSel.setAttribute('data-fp', val);
}

function rangeSaveEdit(index) {
  if (!_rangeState || !_rangeState.shots[index]) return;
  var shot    = _rangeState.shots[index];
  var clubSel = document.getElementById('rangeEditClub-' + index);
  var ydsSel  = document.getElementById('rangeEditYds-' + index);
  if (clubSel) { shot.clubId = clubSel.value; var fp = clubSel.getAttribute('data-fp'); if (fp) shot.flight_path = fp; }
  if (ydsSel)  { shot.yardage = ydsSel.value !== '' ? (parseInt(ydsSel.value, 10) || null) : null; }
  window._rangeState = _rangeState;
  _rangePersist();
  _editingIndex = null;
  var logEl = document.getElementById('rangeShotLog');
  if (logEl) logEl.innerHTML = _renderShotLog(null);
}

function rangeDeleteShot(index) {
  if (!_rangeState) return;
  _rangeState.shots.splice(index, 1);
  window._rangeState = _rangeState;
  _rangePersist();
  _editingIndex = null;
  _renderRoot(_renderShotScreen());
}

function rangeCommit() {
  if (!_rangeState || !_rangeState.shots.length) return;
  _renderRoot(_renderCommitScreen());
}

function _rangeConfirmCommit() {
  if (!_rangeState) return;
  // NOTE: distance type is carry (not total yardage)  -  see range.js header.
  // shots[] is intentionally omitted from the saved record  -  discarded at commit per spec.
  var clubSummary = _buildClubSummary(_rangeState.shots);
  var toSave = {
    sessionId:   _rangeState.sessionId,
    date:        _rangeState.date,
    committed:   true,
    clubSummary: clubSummary
  };
  if (Array.isArray(rangeSessions)) rangeSessions.push(toSave);
  save();
  if (window.syncSave) window.syncSave();
  localStorage.removeItem('gordy:activeRange');
  _rangeState         = null;
  _pendingRing        = null;
  _pendingSegment     = null;
  _editingIndex       = null;
  _selectedSummaryKey = null;
  window._rangeState  = null;
  if (window.updateSessionPill) window.updateSessionPill();
  _renderRoot(
    '<div class="card"><div style="text-align:center;padding:16px 0">' +
      '<div style="font-size:1.4rem;margin-bottom:8px">\u2713</div>' +
      '<div style="font-family:\'Playfair Display\',serif;font-size:1rem;color:var(--ac2);margin-bottom:4px">Session Saved</div>' +
      '<div style="font-size:.65rem;color:var(--tx3)">Your range session has been committed.</div>' +
    '</div>' +
    '<button class="rbtn" onclick="rangeInit()" style="margin-top:8px">Start New Session</button>' +
    '<button class="btn sec" onclick="showTab(\'clubs\')" style="margin-top:6px;width:100%">Update club ranges \u2192</button>' +
    '</div>'
  );
}

function rangeDiscard() {
  if (document.getElementById('rangeDiscardConfirm')) return;
  var btn = document.querySelector('[onclick="rangeDiscard()"]');
  if (!btn) return;
  var wrap = document.createElement('div');
  wrap.id = 'rangeDiscardConfirm';
  wrap.style.cssText = 'margin-top:8px;font-size:.68rem;color:var(--danger);display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  wrap.innerHTML = '<span>Discard this session? All shots will be lost.</span>' +
    '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);font-size:.62rem;padding:2px 8px" onclick="_rangeConfirmDiscard()">Discard</button>' +
    '<button class="btn sec" style="font-size:.62rem;padding:2px 8px" onclick="document.getElementById(\'rangeDiscardConfirm\').remove()">Cancel</button>';
  btn.parentNode.insertBefore(wrap, btn.nextSibling);
}

function _rangeConfirmDiscard() {
  localStorage.removeItem('gordy:activeRange');
  _rangeState         = null;
  _pendingRing        = null;
  _pendingSegment     = null;
  _editingIndex       = null;
  _selectedSummaryKey = null;
  window._rangeState  = null;
  if (window.updateSessionPill) window.updateSessionPill();
  _renderRoot(_renderStartScreen());
}

// function rangeToggleEllipse() { ... } // removed per 2026-04-08 rebuild

// Collapsible toggles
function _rangeToggleClubs() {
  var body = document.getElementById('rangeClubBody');
  var hdr  = document.getElementById('rangeClubHdr');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (hdr) hdr.textContent = 'Clubs ' + (open ? '\u25BA' : '\u25BC');
}

function _rangeToggleLog() {
  var body = document.getElementById('rangeLogBody');
  var hdr  = document.getElementById('rangeLogHdr');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (hdr) hdr.textContent = 'Session Log (' + (_rangeState ? _rangeState.shots.length : 0) + ') ' + (open ? '\u25BA' : '\u25BC');
}

function _rangeToggleSummary() {
  var body = document.getElementById('rangeSummaryBody');
  var hdr  = document.getElementById('rangeSummaryHdr');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (hdr) hdr.textContent = 'Session Summary ' + (open ? '\u25BA' : '\u25BC');
}

function _rangeToggleDist() {
  var body = document.getElementById('rangeDistBody');
  var hdr  = document.getElementById('rangeDistHdr');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (hdr) hdr.textContent = 'Shot Distribution ' + (open ? '\u25BA' : '\u25BC');
}

// Single-select toggle  -  drives Shot Distribution radial surgically
function _rangeSummarySelect(key) {
  _selectedSummaryKey = (_selectedSummaryKey === key) ? null : key;
  // Surgical row highlight update
  var body = document.getElementById('rangeSummaryBody');
  if (body) {
    var rows = body.querySelectorAll('[data-key]');
    rows.forEach(function(r) {
      var isOn = r.getAttribute('data-key') === _selectedSummaryKey;
      r.style.background  = isOn ? 'var(--gr3)' : '';
      r.style.borderColor = isOn ? 'var(--gr2)' : '';
    });
  }
  // Surgical distribution radial update
  var distBody = document.getElementById('rangeDistBody');
  if (distBody && _rangeState) {
    var shots = _rangeState.shots;
    if (_selectedSummaryKey) {
      var parts         = _selectedSummaryKey.split('|');
      var filterClubId  = parts[0];
      var filterYardage = parseInt(parts[1], 10);
      shots = shots.filter(function(s) {
        return s.clubId === filterClubId && (s.yardage || 0) === filterYardage;
      });
    }
    var data = _calcShotCounts(shots);
    distBody.innerHTML = _buildRadialSVG(null, null, true, data.counts, data.max);
  }
}

function _rangePersist() {
  if (_rangeState) localStorage.setItem('gordy:activeRange', JSON.stringify(_rangeState));
}

// -----------------------------------------------------------------------------
// Sessions tab rendering
// -----------------------------------------------------------------------------

function renderRangeSessions() {
  var el = document.getElementById('rangeSessionsList');
  if (!el) return;
  var committed = rangeSessions.filter(function(s) { return s.committed; });
  if (!committed.length) { el.innerHTML = ''; return; }
  var sorted = committed.slice().sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
  el.innerHTML = sorted.map(function(s) {
    var d = fmtDate(s.date);
    var delBtn = '<button style="background:var(--danger);color:white;border:1px solid var(--danger);border-radius:4px;cursor:pointer;font-size:1rem;padding:4px 8px;line-height:1"' +
      ' onclick="event.stopPropagation();confirmDeleteRangeSession(\'' + s.sessionId + '\')">\u2715</button>';
    if (!s.clubSummary || !s.clubSummary.length) {
      return '<div class="hist-item" id="rsi-' + s.sessionId + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
          '<div style="min-width:0;flex:1">' +
            '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ac);margin-bottom:2px;">\uD83C\uDFAF Range Session</div>' +
            '<div style="font-size:.65rem;color:var(--tx3)">Session data unavailable \u2014 recorded before current version.</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
            '<div style="font-size:.6rem;color:var(--tx3);white-space:nowrap;">' + d + '</div>' +
            delBtn +
          '</div>' +
        '</div>' +
      '</div>';
    }
    var breakdownRows = '';
    s.clubSummary.forEach(function(ce) {
      ce.targets.forEach(function(t) {
        var total    = t.shotCount;
        var bullCnt  = t.dispersion.bull.total;
        var innerCnt = Object.values(t.dispersion.inner).reduce(function(a, z) { return a + z.total; }, 0);
        var outerCnt = Object.values(t.dispersion.outer).reduce(function(a, z) { return a + z.total; }, 0);
        var pct = function(n) { return total ? Math.round(n / total * 100) + '%' : '0%'; };
        var cName = ce.clubName || _clubName(ce.clubId);
        breakdownRows += '<div style="font-size:.62rem;color:var(--tx3);margin-top:2px">' +
          cName + ' \u00B7 ' + t.yardage + ' yds \u00B7 Bull ' + pct(bullCnt) + ' / Inner ' + pct(innerCnt) + ' / Outer ' + pct(outerCnt) + '</div>';
      });
    });
    var allClubs = [];
    s.clubSummary.forEach(function(ce) {
      var n = ce.clubName || _clubName(ce.clubId);
      if (allClubs.indexOf(n) === -1) allClubs.push(n);
    });
    return '<div class="hist-item" id="rsi-' + s.sessionId + '" onclick="toggleRangeSession(\'' + s.sessionId + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ac);margin-bottom:2px;">\uD83C\uDFAF Range Session</div>' +
          '<div class="hist-course">' + allClubs.join(', ') + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
          '<div style="font-size:.6rem;color:var(--tx3);white-space:nowrap;">' + d + '</div>' +
          delBtn +
        '</div>' +
      '</div>' +
      '<div class="hist-body">' + breakdownRows + '</div>' +
    '</div>';
  }).join('');
}

// -----------------------------------------------------------------------------
// window exposure
// -----------------------------------------------------------------------------

Object.assign(window, {
  rangeInit, rangeStartSession, rangeSelectClub,
  rangeSetTarget,
  // rangeSetFairway,    // removed per 2026-04-08 rebuild
  rangeRecordShot, rangeZoneTap, rangeFlightSelect,
  rangeEditShot, rangeEditFlightSelect, rangeSaveEdit, rangeDeleteShot,
  rangeCommit, rangeDiscard,
  // rangeToggleEllipse, // removed per 2026-04-08 rebuild
  _rangeToggleClubs, _rangeToggleLog, _rangeToggleSummary, _rangeToggleDist,
  _rangeConfirmCommit, _rangeConfirmDiscard, _rangeSummarySelect,
  renderRangeSessions
});
