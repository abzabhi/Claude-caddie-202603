/**
 * range.js — Range Session tab for Gordy the Virtual Caddy.
 *
 * Rules:
 *   - No Unicode literals — use \uXXXX escapes.
 *   - All functions called from HTML onclick must be on window via Object.assign.
 *   - Old code commented out, never deleted.
 *   - Strict mode via type="module" in index.html.
 */

import { bag, history as storeHistory, save } from './store.js';
import {
  generateSessionId, SESSION_TYPES,
  ZONE_SEGMENT_LABELS, ZONE_RING_RADII,
  FLIGHT_PATHS
} from './constants.js';
import { tierIndex } from './geo.js';

// -----------------------------------------------------------------------------
// Module-level state
// -----------------------------------------------------------------------------

var _rangeState     = null; // active range session or null
var _sessionStart   = 0;   // Date.now() at session start (for timestampDelta)
var _editingIndex   = null; // index of shot being edited, or null
var _pendingRing    = null; // zone selection for next shot
var _pendingSegment = null;
var _pendingFlight  = 'straight';

window._rangeState        = null;  // kept in sync — read by _getActiveRange
window._rangeEllipseActive = false; // cross-tab flag — Viz tab reads on render

// _rangeState shape:
// {
//   sessionId, date, clubId, club_bag_snapshot,
//   shots[], committed: false,
//   targetYardage: null,
//   _sessionStart: Number  (internal — stripped before commit write)
// }

// Shot record shape:
// {
//   sessionId, sessionType, clubId,
//   radial_ring, radial_segment, flight_path,
//   timestamp, timestampDelta, yardage, entryType
// }

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

function _rangePersist() {
  if (_rangeState) localStorage.setItem('gordy:activeRange', JSON.stringify(_rangeState));
}

// -----------------------------------------------------------------------------
// SVG Radial component
// -----------------------------------------------------------------------------

function _pt(cx, cy, r, angleDeg) {
  var rad = angleDeg * Math.PI / 180;
  return {
    x: +(cx + r * Math.sin(rad)).toFixed(3),
    y: +(cy - r * Math.cos(rad)).toFixed(3)
  };
}

function _arcPath(cx, cy, r1, r2, startDeg, endDeg) {
  var s1 = _pt(cx, cy, r2, startDeg);
  var e1 = _pt(cx, cy, r2, endDeg);
  var s2 = _pt(cx, cy, r1, endDeg);
  var e2 = _pt(cx, cy, r1, startDeg);
  // large-arc-flag = 0 (each segment = 45 deg, always small arc)
  return (
    'M ' + s1.x + ' ' + s1.y +
    ' A ' + r2 + ' ' + r2 + ' 0 0 1 ' + e1.x + ' ' + e1.y +
    ' L ' + s2.x + ' ' + s2.y +
    ' A ' + r1 + ' ' + r1 + ' 0 0 0 ' + e2.x + ' ' + e2.y +
    ' Z'
  );
}

/**
 * Build the SVG radial zone picker.
 * @param {string|null} selectedRing  'bull' | 'inner' | 'outer' | null
 * @param {number|null} selectedSeg   0-7 | null
 * @param {boolean}     isStatic      if true, omit onclick (used in edit form display)
 */
function _buildRadialSVG(selectedRing, selectedSeg, isStatic) {
  var cx = 150, cy = 150;
  var rBull  = ZONE_RING_RADII.bull;
  var rInner = ZONE_RING_RADII.inner;
  var rOuter = ZONE_RING_RADII.outer;
  var paths  = '';

  // 8 inner segments
  for (var i = 0; i < 8; i++) {
    var a1 = (i * 45) - 22.5;
    var a2 = (i * 45) + 22.5;
    var sel = (selectedRing === 'inner' && selectedSeg === i);
    var d   = _arcPath(cx, cy, rBull, rInner, a1, a2);
    var handler = isStatic ? '' :
      ' onclick="rangeZoneTap(\'inner\',' + i + ')" style="cursor:pointer;touch-action:manipulation"';
    paths += '<path id="zone-' + i + '-inner" d="' + d + '"' +
      ' fill="' + (sel ? 'var(--gr)'  : 'var(--sf2)') + '"' +
      ' stroke="' + (sel ? 'white'    : 'var(--br)')  + '"' +
      ' stroke-width="' + (sel ? '2' : '1') + '"' + handler + '></path>';
  }

  // 8 outer segments
  for (var j = 0; j < 8; j++) {
    var b1  = (j * 45) - 22.5;
    var b2  = (j * 45) + 22.5;
    var sel2 = (selectedRing === 'outer' && selectedSeg === j);
    var d2   = _arcPath(cx, cy, rInner, rOuter, b1, b2);
    var handler2 = isStatic ? '' :
      ' onclick="rangeZoneTap(\'outer\',' + j + ')" style="cursor:pointer;touch-action:manipulation"';
    paths += '<path id="zone-' + j + '-outer" d="' + d2 + '"' +
      ' fill="' + (sel2 ? 'var(--gr)' : 'var(--sf2)') + '"' +
      ' stroke="' + (sel2 ? 'white'   : 'var(--br)') + '"' +
      ' stroke-width="' + (sel2 ? '2' : '1') + '"' + handler2 + '></path>';
  }

  // Bullseye
  var bullSel = (selectedRing === 'bull');
  var bullHandler = isStatic ? '' :
    ' onclick="rangeZoneTap(\'bull\',null)" style="cursor:pointer;touch-action:manipulation"';
  paths += '<circle id="zone-bull" cx="' + cx + '" cy="' + cy + '" r="' + rBull + '"' +
    ' fill="' + (bullSel ? 'var(--ac2)' : 'var(--sf2)') + '"' +
    ' stroke="' + (bullSel ? 'white'    : 'var(--br)')  + '"' +
    ' stroke-width="' + (bullSel ? '2' : '1') + '"' + bullHandler + '></circle>';

  // Zone label below SVG
  var zoneLabel = '\u2014';
  if (selectedRing === 'bull') {
    zoneLabel = 'Bull';
  } else if (selectedRing && selectedSeg !== null && selectedSeg !== undefined) {
    var ringLbl = selectedRing === 'inner' ? 'Inner' : 'Outer';
    zoneLabel = ringLbl + ' \u00B7 ' + ZONE_SEGMENT_LABELS[selectedSeg];
  }

  return (
    '<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"' +
    ' style="width:100%;max-width:300px;display:block;margin:0 auto">' +
    paths + '</svg>' +
    '<div style="text-align:center;font-size:.68rem;color:var(--tx2);margin-top:6px">' +
    zoneLabel + '</div>'
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _activeBag() {
  return bag.filter(function(c) { return c.tested === true; });
}

function _clubDisplayName(clubId) {
  var c = bag.find(function(x) { return x.id === clubId; });
  if (!c) return '(unknown)';
  return c.identifier || c.type || 'Club';
}

function _clubDistRange(clubId) {
  var c = bag.find(function(x) { return x.id === clubId; });
  if (!c || !c.sessions || !c.sessions.length) return '';
  var maxes = c.sessions.map(function(s) { return +s.max; }).filter(function(v) { return v > 0; });
  var mins  = c.sessions.map(function(s) { return +s.min; }).filter(function(v) { return v > 0; });
  if (!maxes.length) return '';
  var avgMax = Math.round(maxes.reduce(function(a, b) { return a + b; }, 0) / maxes.length);
  var avgMin = mins.length
    ? Math.round(mins.reduce(function(a, b) { return a + b; }, 0) / mins.length)
    : null;
  return avgMin ? (avgMin + '\u2013' + avgMax + ' yds') : ('\u2264' + avgMax + ' yds');
}

function _flightLabel(val) {
  var fp = FLIGHT_PATHS.find(function(f) { return f.value === val; });
  return fp ? fp.label : val;
}

function _ringLabel(ring) {
  if (ring === 'bull')  return 'Bull';
  if (ring === 'inner') return 'Inner';
  if (ring === 'outer') return 'Outer';
  return ring;
}

// -----------------------------------------------------------------------------
// HTML templates
// -----------------------------------------------------------------------------

function _renderStartScreen() {
  var clubs = _activeBag();
  var opts  = clubs.length
    ? clubs.map(function(c) {
        return '<option value="' + c.id + '">' + _clubDisplayName(c.id) + '</option>';
      }).join('')
    : '<option value="">No active clubs</option>';

  return (
    '<div class="card">' +
      '<div class="card-title">Start Range Session</div>' +
      '<div class="field">' +
        '<div class="flbl">Club</div>' +
        '<select id="rangeStartClubSel">' + opts + '</select>' +
      '</div>' +
      '<button class="rbtn" onclick="rangeStartSession(document.getElementById(\'rangeStartClubSel\').value)">Start Session</button>' +
    '</div>'
  );
}

function _shotRowHtml(shot, idx, editingIdx) {
  var club = _clubDisplayName(shot.clubId);
  var zone = shot.radial_ring === 'bull'
    ? 'Bull'
    : _ringLabel(shot.radial_ring) + ' \u00B7 ' + (ZONE_SEGMENT_LABELS[shot.radial_segment] || '');
  var yds  = shot.yardage ? shot.yardage + 'yd ' : '';
  var fp   = _flightLabel(shot.flight_path);
  var isEd = (editingIdx === idx);

  var row = (
    '<div class="hist-item" id="rangeShot-' + idx + '" style="flex-direction:column;align-items:stretch">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-size:.68rem">Shot\u00A0' + (idx + 1) + ' \u00B7 ' + club + ' \u00B7 ' + yds + zone + ' \u00B7 ' + fp + '</span>' +
        '<span style="display:flex;gap:5px;flex-shrink:0">' +
          '<button class="btn sec" style="font-size:.56rem;padding:2px 6px" onclick="rangeEditShot(' + idx + ')">' + (isEd ? 'Cancel' : 'Edit') + '</button>' +
          '<button class="btn" style="font-size:.56rem;padding:2px 6px;color:var(--danger);border-color:var(--danger)" onclick="rangeDeleteShot(' + idx + ')">\u2715</button>' +
        '</span>' +
      '</div>'
  );

  if (isEd) { row += _renderEditForm(shot, idx); }
  row += '</div>';
  return row;
}

function _renderEditForm(shot, idx) {
  var clubs   = _activeBag();
  var clubOpts = clubs.map(function(c) {
    return '<option value="' + c.id + '"' + (c.id === shot.clubId ? ' selected' : '') + '>' + _clubDisplayName(c.id) + '</option>';
  }).join('');

  var fpBtns = FLIGHT_PATHS.map(function(fp) {
    return '<button class="implied-tog' + (shot.flight_path === fp.value ? ' on' : '') + '"' +
      ' id="rangeEditFp-' + idx + '-' + fp.value + '"' +
      ' onclick="rangeEditFlightSelect(\'' + fp.value + '\',' + idx + ')">' +
      fp.label + '</button>';
  }).join('');

  var curZone = shot.radial_ring === 'bull'
    ? 'Bull'
    : _ringLabel(shot.radial_ring) + ' \u00B7 ' + (ZONE_SEGMENT_LABELS[shot.radial_segment] || '');

  return (
    '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--br)">' +
      '<div class="field"><div class="flbl">Club</div>' +
        '<select id="rangeEditClub-' + idx + '">' + clubOpts + '</select>' +
      '</div>' +
      '<div class="field"><div class="flbl">Target (yds)</div>' +
        '<input type="number" inputmode="numeric" id="rangeEditYds-' + idx + '"' +
        ' value="' + (shot.yardage || '') + '" style="width:90px">' +
      '</div>' +
      '<div style="font-size:.62rem;color:var(--tx3);margin-bottom:6px">Zone: ' + curZone + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' + fpBtns + '</div>' +
      '<button class="rbtn" onclick="rangeSaveEdit(' + idx + ')">Save</button>' +
    '</div>'
  );
}

function _renderShotLog(editingIdx) {
  if (!_rangeState || !_rangeState.shots.length) {
    return '<div class="hist-empty">No shots yet \u2014 log your first shot above.</div>';
  }
  return _rangeState.shots.map(function(s, i) { return _shotRowHtml(s, i, editingIdx); }).join('');
}

function _renderShotScreen() {
  var clubs     = _activeBag();
  var clubOpts  = clubs.map(function(c) {
    return '<option value="' + c.id + '"' + (c.id === _rangeState.clubId ? ' selected' : '') + '>' + _clubDisplayName(c.id) + '</option>';
  }).join('');
  var club      = _clubDisplayName(_rangeState.clubId);
  var dist      = _clubDistRange(_rangeState.clubId);
  var shotCount = _rangeState.shots.length;

  var fpBtns = FLIGHT_PATHS.map(function(fp) {
    return '<button class="implied-tog' + (fp.value === _pendingFlight ? ' on' : '') + '"' +
      ' id="rangeFp-' + fp.value + '"' +
      ' onclick="rangeFlightSelect(\'' + fp.value + '\')">' + fp.label + '</button>';
  }).join('');

  var commitBtn = shotCount
    ? '<button class="rbtn" onclick="rangeCommit()" style="margin-top:12px">Commit Session</button>'
    : '';

  return (
    '<div class="card" style="margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
        '<div>' +
          '<div style="font-family:\'Playfair Display\',serif;font-size:1rem;font-weight:600;color:var(--ac2)">' + club + '</div>' +
          (dist ? '<div style="font-size:.63rem;color:var(--tx3);margin-top:2px">' + dist + '</div>' : '') +
        '</div>' +
        '<select style="font-size:.65rem" onchange="rangeSelectClub(this.value)">' + clubOpts + '</select>' +
      '</div>' +
    '</div>' +

    '<div class="card" style="margin-bottom:10px">' +
      '<div class="card-title">Target</div>' +
      '<div class="field">' +
        '<div class="flbl">Target (yards)</div>' +
        '<input type="number" inputmode="numeric" id="rangeTargetInput"' +
        ' value="' + (_rangeState.targetYardage || '') + '" style="width:100px"' +
        ' onchange="rangeSetTarget(this.value)">' +
      '</div>' +
    '</div>' +

    '<div class="card" style="margin-bottom:10px">' +
      '<div class="card-title">Shot Result</div>' +
      '<div id="rangeSvgWrap">' + _buildRadialSVG(_pendingRing, _pendingSegment, false) + '</div>' +
      '<div style="display:flex;gap:6px;margin:10px 0 8px;flex-wrap:wrap">' + fpBtns + '</div>' +
      '<button class="rbtn" onclick="rangeRecordShot()">\uD83C\uDFAF Record Shot</button>' +
      '<div id="rangeRecordErr" style="display:none;font-size:.65rem;color:var(--danger);margin-top:6px"></div>' +
    '</div>' +

    '<div class="collapsible-hdr" onclick="_rangeToggleLog()" id="rangeLogHdr">Session Log (' + shotCount + ') \u25BC</div>' +
    '<div id="rangeLogBody">' +
      '<div id="rangeShotLog">' + _renderShotLog(null) + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
        '<span class="slbl">Show ellipse</span>' +
        '<button class="implied-tog' + (window._rangeEllipseActive ? ' on' : '') + '" id="rangeEllipseToggle" onclick="rangeToggleEllipse()">' +
        (window._rangeEllipseActive ? 'On' : 'Off') + '</button>' +
      '</div>' +
      '<button class="btn" style="color:var(--danger);border-color:var(--danger);width:100%;margin-top:10px" onclick="rangeDiscard()">Discard Session</button>' +
    '</div>' +

    commitBtn
  );
}

function _renderCommitScreen() {
  var shots  = _rangeState.shots;
  var total  = shots.length;
  var pct    = function(n) { return total ? Math.round(n / total * 100) : 0; };
  var bulls  = shots.filter(function(s) { return s.radial_ring === 'bull'; }).length;
  var inners = shots.filter(function(s) { return s.radial_ring === 'inner'; }).length;
  var outers = shots.filter(function(s) { return s.radial_ring === 'outer'; }).length;
  var fpLines = FLIGHT_PATHS.map(function(fp) {
    var n = shots.filter(function(s) { return s.flight_path === fp.value; }).length;
    return fp.label + ': ' + pct(n) + '%';
  }).join(' / ');

  return (
    '<div class="card" style="margin-bottom:10px">' +
      '<div class="card-title">Session Summary</div>' +
      '<div style="font-size:.72rem;color:var(--tx2);line-height:2">' +
        'Total shots: ' + total + '<br>' +
        'Club: ' + _clubDisplayName(_rangeState.clubId) + '<br>' +
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
  if (!_rangeState) {
    var raw = localStorage.getItem('gordy:activeRange');
    if (raw) {
      try {
        _rangeState = JSON.parse(raw);
        window._rangeState = _rangeState;
        _sessionStart = _rangeState._sessionStart || Date.now();
      } catch(e) {
        _rangeState = null;
        window._rangeState = null;
      }
    }
  }
  _editingIndex = null;
  _renderRoot(_rangeState ? _renderShotScreen() : _renderStartScreen());
}

function rangeStartSession(clubId) {
  if (!clubId) return;
  var now = Date.now();
  _rangeState = {
    sessionId:         generateSessionId(SESSION_TYPES.RANGE),
    date:              new Date().toISOString().slice(0, 10),
    clubId:            clubId,
    club_bag_snapshot: _activeBag().map(function(c) { return c.id; }),
    shots:             [],
    committed:         false,
    targetYardage:     null,
    _sessionStart:     now
  };
  _sessionStart   = now;
  _pendingRing    = null;
  _pendingSegment = null;
  _pendingFlight  = 'straight';
  _editingIndex   = null;
  window._rangeState = _rangeState;
  _rangePersist();
  if (window.updateSessionPill) window.updateSessionPill();
  _renderRoot(_renderShotScreen());
}

function rangeSelectClub(clubId) {
  if (!_rangeState || !clubId) return;
  _rangeState.clubId = clubId;
  window._rangeState = _rangeState;
  _rangePersist();
  _renderRoot(_renderShotScreen());
}

function rangeSetTarget(yards) {
  if (!_rangeState) return;
  _rangeState.targetYardage = (yards === '' || yards === null) ? null : (parseInt(yards, 10) || null);
  window._rangeState = _rangeState;
  _rangePersist();
}

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
    if (!btn) return;
    if (fp.value === val) btn.classList.add('on'); else btn.classList.remove('on');
  });
}

function rangeRecordShot() {
  if (!_rangeState) return;
  var errEl = document.getElementById('rangeRecordErr');
  if (!_pendingRing) {
    if (errEl) { errEl.textContent = 'Select a zone on the radial first.'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  // Sync target from input in case onchange did not fire (mobile tap-out)
  var inp = document.getElementById('rangeTargetInput');
  if (inp && inp.value !== '') _rangeState.targetYardage = parseInt(inp.value, 10) || null;

  var shot = {
    sessionId:      _rangeState.sessionId,
    sessionType:    SESSION_TYPES.RANGE,
    clubId:         _rangeState.clubId,
    radial_ring:    _pendingRing,
    radial_segment: _pendingSegment,
    flight_path:    _pendingFlight,
    timestamp:      new Date().toISOString(),
    timestampDelta: Math.floor((Date.now() - _sessionStart) / 1000),
    yardage:        _rangeState.targetYardage || null,
    entryType:      SESSION_TYPES.RANGE
  };

  _rangeState.shots.push(shot);
  window._rangeState = _rangeState;
  _rangePersist();
  if (window.updateSessionPill) window.updateSessionPill();

  // Reset zone for next shot; keep club, target, flight
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
    if (!btn) return;
    if (fp.value === val) btn.classList.add('on'); else btn.classList.remove('on');
  });
  // Stash on club select as data attribute (safe data mule between taps)
  var clubSel = document.getElementById('rangeEditClub-' + idx);
  if (clubSel) clubSel.setAttribute('data-fp', val);
}

function rangeSaveEdit(index) {
  if (!_rangeState || !_rangeState.shots[index]) return;
  var shot    = _rangeState.shots[index];
  var clubSel = document.getElementById('rangeEditClub-' + index);
  var ydsSel  = document.getElementById('rangeEditYds-' + index);

  if (clubSel) {
    shot.clubId = clubSel.value;
    var fpOverride = clubSel.getAttribute('data-fp');
    if (fpOverride) shot.flight_path = fpOverride;
  }
  if (ydsSel) {
    shot.yardage = ydsSel.value !== '' ? (parseInt(ydsSel.value, 10) || null) : null;
  }

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
  _rangeState.committed = true;

  var ydsShots = _rangeState.shots.filter(function(s) { return s.yardage; });
  if (ydsShots.length) {
    _rangeState.averageYardage = Math.round(
      ydsShots.reduce(function(acc, s) { return acc + s.yardage; }, 0) / ydsShots.length
    );
  }

  var toSave = Object.assign({}, _rangeState);
  delete toSave._sessionStart;

  if (Array.isArray(storeHistory)) storeHistory.push(toSave);
  save();

  localStorage.removeItem('gordy:activeRange');
  _rangeState     = null;
  _pendingRing    = null;
  _pendingSegment = null;
  _editingIndex   = null;
  window._rangeState = null;
  if (window.updateSessionPill) window.updateSessionPill();

  _renderRoot(
    '<div class="card">' +
      '<div style="text-align:center;padding:16px 0">' +
        '<div style="font-size:1.4rem;margin-bottom:8px">\u2713</div>' +
        '<div style="font-family:\'Playfair Display\',serif;font-size:1rem;color:var(--ac2);margin-bottom:4px">Session Saved</div>' +
        '<div style="font-size:.65rem;color:var(--tx3)">Your range session has been committed.</div>' +
      '</div>' +
      '<button class="rbtn" onclick="rangeInit()" style="margin-top:8px">Start New Session</button>' +
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
  wrap.innerHTML = (
    '<span>Discard this session? All shots will be lost.</span>' +
    '<button class="btn" style="color:var(--danger);border-color:var(--danger);font-size:.62rem;padding:2px 8px" onclick="_rangeConfirmDiscard()">Discard</button>' +
    '<button class="btn sec" style="font-size:.62rem;padding:2px 8px" onclick="document.getElementById(\'rangeDiscardConfirm\').remove()">Cancel</button>'
  );
  btn.parentNode.insertBefore(wrap, btn.nextSibling);
}

function _rangeConfirmDiscard() {
  localStorage.removeItem('gordy:activeRange');
  _rangeState     = null;
  _pendingRing    = null;
  _pendingSegment = null;
  _editingIndex   = null;
  window._rangeState = null;
  if (window.updateSessionPill) window.updateSessionPill();
  _renderRoot(_renderStartScreen());
}

function rangeToggleEllipse() {
  window._rangeEllipseActive = !window._rangeEllipseActive;
  var btn = document.getElementById('rangeEllipseToggle');
  if (btn) {
    btn.textContent = window._rangeEllipseActive ? 'On' : 'Off';
    if (window._rangeEllipseActive) btn.classList.add('on'); else btn.classList.remove('on');
  }
}

function _rangeToggleLog() {
  var body = document.getElementById('rangeLogBody');
  var hdr  = document.getElementById('rangeLogHdr');
  if (!body) return;
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (hdr) {
    var count = _rangeState ? _rangeState.shots.length : 0;
    hdr.textContent = 'Session Log (' + count + ') ' + (open ? '\u25BA' : '\u25BC');
  }
}

// -----------------------------------------------------------------------------
// window exposure
// -----------------------------------------------------------------------------

Object.assign(window, {
  rangeInit,
  rangeStartSession,
  rangeSelectClub,
  rangeSetTarget,
  rangeRecordShot,
  rangeZoneTap,
  rangeFlightSelect,
  rangeEditShot,
  rangeEditFlightSelect,
  rangeSaveEdit,
  rangeDeleteShot,
  rangeCommit,
  rangeDiscard,
  rangeToggleEllipse,
  _rangeToggleLog,
  _rangeConfirmCommit,
  _rangeConfirmDiscard
});
