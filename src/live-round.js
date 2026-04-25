import { uid, today, save, courses, rounds, history, profile, bag } from './store.js';
import { ZONE_SEGMENT_LABELS, ZONE_RING_RADII, sgExpected } from './constants.js';
import { calcDiff, clubSlug, localISO } from './geo.js'; /* CLEAN11 */
import { renderHandicap } from './rounds.js';
/* G2 -- geomap integration for in-round map view */
import { geomCreateMap, geomLoadByCenter, geomLoadByCourse, geomSearchByLocation,
         geomRenderGeometry, geomShowHole,
         geomStartGpsWatch, geomStopGpsWatch, geomDistanceYds,
         geomBearingDeg, geomGetCurrentPosition, geomRenderPath } from './geomap.js';

/* CLEAN11 -- _localISO centralised to geo.js as localISO(); local copy commented out
function _localISO() { var n=new Date(),p=function(x){return x<10?'0'+x:''+x;}; return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+'T'+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds()); }
*/

// \u2500\u2500 Live Round Tracker \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// lrState shape:
// { courseId, courseName, tee, date, conditions, mode, countForHandicap,
//   holes:[{n,par,yards,handicap}], players:[{id,name,isMe,handicap,scores:[{score,putts,gir,notes}]}],
//   mePlayerId, teams:[{name,playerIds:[]}], curHole, netView }

// \u2500\u2500 Mode metadata \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const LR_MODES = {
stroke:     { label:'Stroke Play',          teams:false, shared:false },
stableford: { label:'Stableford',           teams:false, shared:false },
matchplay:  { label:'Match Play',           teams:true,  shared:false },
bestball:   { label:'Best Ball',            teams:true,  shared:false },
scramble:   { label:'Scramble',             teams:true,  shared:true  },
foursomes:  { label:'Foursomes (Alt. Shot)',teams:true,  shared:true  },
};
const LR_MODE_NOTES = {
matchplay:  'Two players or two teams. Winner decided by holes won, not total strokes.',
bestball:   'Each player plays their own ball. Best score on each hole counts for the team.',
scramble:   'All players tee off, best shot chosen, everyone plays from there. One team score per hole.',
foursomes:  'Two teams, alternate shot. One ball per team, players alternate hitting.',
};

// \u2500\u2500 Setup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrStartSetup() {
if(lrState) { lrExpand(); return; }
// Populate course dropdown
const sel = document.getElementById('lrCourseSelect');
sel.innerHTML = '<option value="">\u2014 Impromptu / no course \u2014</option>'
  + courses.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
// Date default
document.getElementById('lrDate').value = today();
// Init player slots with one player (you)
lrInitPlayerSlots();
lrOnModeChange();
document.getElementById('lrOverlay').classList.add('active');
lrShowScreen('lrSetup');
}

function lrInitPlayerSlots() {
// Single default player slot
const container = document.getElementById('lrPlayerSlots');
container.innerHTML = '';
lrAddPlayerSlot(1, true); // player 1, isMe=true by default
}

let _lrPlayerCount = 1;
function lrAddPlayerSlot(n, isMe) {
const container = document.getElementById('lrPlayerSlots');
const pid = 'lrp'+n;
const div = document.createElement('div');
div.className = 'lr-player-slot';
div.id = 'lrSlot'+n;
div.dataset.n = n;
div.innerHTML = `
  <button class="lr-tog ${isMe?'on-y':''}" style="width:32px;padding:6px;flex-shrink:0" onclick="lrToggleMe(${n})" title="Mark as you">\u2605</button>
  <input class="field" style="flex:1;background:var(--bg);border:1px solid var(--br);border-radius:4px;color:var(--tx);font-family:'DM Mono',monospace;font-size:.72rem;padding:5px 8px;outline:none" placeholder="Player ${n} name" id="lrPName${n}" value="${isMe&&(profile.name||'')?profile.name:''}">
  <input class="field" style="width:52px;background:var(--bg);border:1px solid var(--br);border-radius:4px;color:var(--tx);font-family:'DM Mono',monospace;font-size:.72rem;padding:5px 8px;outline:none;text-align:center" placeholder="HCP" id="lrPHcp${n}" inputmode="decimal">
  ${n>1?`<button style="background:none;border:none;color:var(--tx3);cursor:pointer;font-size:.8rem;padding:2px 6px" onclick="lrRemovePlayer(${n})">\u2715</button>`:''}
`;
container.appendChild(div);
if(isMe) {
  // Mark all others as not-me
  container.querySelectorAll('.lr-tog').forEach((b,i)=>{ if(i>0) b.classList.remove('on-y'); });
}
}

function lrToggleMe(n) {
// Only one player can be "me"
document.querySelectorAll('.lr-player-slot .lr-tog').forEach(b=>b.classList.remove('on-y'));
document.querySelector(`#lrSlot${n} .lr-tog`)?.classList.add('on-y');
}

function lrAddPlayer() {
const slots = document.querySelectorAll('.lr-player-slot');
if(slots.length >= 6) return;
_lrPlayerCount++;
lrAddPlayerSlot(_lrPlayerCount, false);
const addBtn = document.getElementById('lrAddPlayerBtn');
if(addBtn) addBtn.style.display = slots.length >= 5 ? 'none' : '';
lrRenderTeamSetup();
}

function lrRemovePlayer(n) {
document.getElementById('lrSlot'+n)?.remove();
const slots = document.querySelectorAll('.lr-player-slot');
const addBtn = document.getElementById('lrAddPlayerBtn');
if(addBtn) addBtn.style.display = slots.length < 6 ? '' : 'none';
lrRenderTeamSetup();
}

function lrOnCourseSelect() {
const val = document.getElementById('lrCourseSelect').value;
const imprompt = document.getElementById('lrImprompt');
const teeRow   = document.getElementById('lrTeeRow');
if(val && val !== '') {
  const course = courses.find(c=>c.id===val);
  teeRow.style.display = course?.tees?.length ? '' : 'none';
  if(course?.tees?.length) {
    document.getElementById('lrTeeSelect').innerHTML =
      course.tees.map(t=>`<option value="${t.id}">${escHtml(t.name)} \u2014 ${t.yardage}y (${t.rating}/${t.slope})</option>`).join('');
  }
  imprompt.style.display = 'none';
} else {
  teeRow.style.display = 'none';
  imprompt.style.display = '';
}
lrRenderSessionPicker();
}

function lrOnHoleCountChange() {
const val = document.getElementById('lrHoleCount').value;
document.getElementById('lrCustomHolesRow').style.display = val==='custom' ? '' : 'none';
}

function lrOnModeChange() {
const mode = document.getElementById('lrMode').value;
const note  = document.getElementById('lrTeamNote');
const teamSetup = document.getElementById('lrTeamSetup');
const hcpChk  = document.getElementById('lrCountHcp');
const hcpLbl  = hcpChk?.parentElement;
// Scramble and foursomes cannot count for handicap
const noHcp = mode==='scramble'||mode==='foursomes';
if(hcpChk) {
  hcpChk.checked  = !noHcp;
  hcpChk.disabled = noHcp;
  if(hcpLbl) hcpLbl.style.opacity = noHcp ? '.4' : '1';
  if(hcpLbl) hcpLbl.title = noHcp ? 'Scramble and foursomes cannot count for handicap' : '';
}
if(LR_MODE_NOTES[mode]) {
  note.textContent = LR_MODE_NOTES[mode];
  note.style.display = '';
} else {
  note.style.display = 'none';
}
const needsTeams = LR_MODES[mode]?.teams;
teamSetup.style.display = needsTeams ? '' : 'none';
if(needsTeams) lrRenderTeamSetup();
}

function lrRenderTeamSetup() {
const mode = document.getElementById('lrMode').value;
if(!LR_MODES[mode]?.teams) return;
const slots = [...document.querySelectorAll('.lr-player-slot')];
const container = document.getElementById('lrTeamRows');
container.innerHTML = slots.map(s=>{
  const n = s.dataset.n;
  const name = document.getElementById('lrPName'+n)?.value || 'Player '+n;
  return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--br);font-size:.68rem">
    <span style="flex:1;color:var(--tx2)">${escHtml(name)}</span>
    <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="lrTeam${n}" value="A" checked> Team A</label>
    <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="lrTeam${n}" value="B"> Team B</label>
  </div>`;
}).join('');
}

function lrBeginRound() {
const mode = document.getElementById('lrMode').value;
const courseId = document.getElementById('lrCourseSelect').value;
const course = courseId ? courses.find(c=>c.id===courseId) : null;
const teeId  = course ? document.getElementById('lrTeeSelect').value : null;
const tee    = course?.tees?.find(t=>t.id===teeId) || course?.tees?.[0] || null;

// Build holes array
let holeArr = [];
if(tee?.holes?.length) {
  holeArr = tee.holes.map(h=>({n:+h.number,par:+h.par||4,yards:+h.yards||0,handicap:+h.handicap||0}));
} else {
  const countRaw = document.getElementById('lrHoleCount').value;
  const count = countRaw==='custom'
    ? (parseInt(document.getElementById('lrCustomHoles').value)||18)
    : +countRaw;
  holeArr = Array.from({length:count},(_,i)=>({n:i+1,par:4,yards:0,handicap:i+1}));
}

// Build players
const slots = [...document.querySelectorAll('.lr-player-slot')];
const players = slots.map(s=>{
  const n = s.dataset.n;
  const isMe = s.querySelector('.lr-tog')?.classList.contains('on-y') || false;
  const name = document.getElementById('lrPName'+n)?.value || 'Player '+n;
  const hcpRaw = document.getElementById('lrPHcp'+n)?.value;
  const handicap = hcpRaw ? parseFloat(hcpRaw) : null;
  return { id:'p'+n, name, isMe, handicap,
    scores: holeArr.map(()=>({score:null,putts:null,gir:null,notes:''})) };
});

const mePlayer = players.find(p=>p.isMe);
const mePlayerId = mePlayer?.id || null;

// Build teams for team modes
let teams = [];
if(LR_MODES[mode]?.teams) {
  const aPlayers=[], bPlayers=[];
  slots.forEach(s=>{
    const n = s.dataset.n;
    const pid = 'p'+n;
    const team = document.querySelector(`input[name="lrTeam${n}"]:checked`)?.value || 'A';
    (team==='A'?aPlayers:bPlayers).push(pid);
  });
  teams = [{name:'Team A',playerIds:aPlayers},{name:'Team B',playerIds:bPlayers}];
}

lrState = {
  courseId: courseId||null,
  courseName: course?.name || document.getElementById('lrCourseName')?.value || 'Unnamed Course',
  tee: tee?.name || '',
  rating: tee?.rating || '',
  slope: tee?.slope || '',
  date: document.getElementById('lrDate').value || today(),
  conditions: document.getElementById('lrConditions').value,
  mode,
  countForHandicap: document.getElementById('lrCountHcp').checked,
  holes: holeArr,
  players,
  mePlayerId,
  teams,
  curHole: 0,       // 0-based index
  curPlayer: 0,     // active player tab index
  netView: false,
  saved: false,
  linkedSessionId: (function() { var s = document.getElementById('lrLinkedSession'); return s && s.value ? s.value : null; })(),
  _sessionBagOpen: false,
  /* G2 -- map view state (all persisted in gordy:activeRound via _lrPersist) */
  _mapPromptSeen: false,
  _mapOpen: false,
  _mapMode: 'simple',          /* 'simple' | 'advanced' */
  _scoringCollapsed: false,
  _gpsOn: false,
  _gpsPrompted: false,
  /* G2b-R -- single draggable aim reticle replaces multi-waypoint chain.
     Reset to tee->green midpoint on each hole load. */
  _mapAim: null,               /* [lon, lat] aim marker; null => init at midpoint on mount */
  _mapTeeLonLat: null,         /* user-dragged tee override; null => geometry tee */
  _mapSearchDone: false,       /* entry modal already shown+answered this round */
  _mapSheetOpen: false,        /* bottom sheet expanded */
  /* _mapPath: [] -- G2b-R removed; superseded by single _mapAim. Waypoint-chain
     rendering + _lrMapRemoveWaypoint/_lrMapClearPath kept as commented stubs. */
  /* _mapSelectedPoint: null -- G2b removed; superseded by _mapAim */
};

lrShowScreen('lrHoleScreen');
lrRenderHole();
_lrPersist();
/* G2b -- full-screen map-search modal replaces the old yes/no prompt.
   _lrMapPromptIfNeeded();  // G2 original, commented out per G2b handoff */
_lrMapSearchModalOpen();
}

function lrCancelSetup() {
document.getElementById('lrOverlay').classList.remove('active');
if(window.showTab) window.showTab('rounds');
}

// \u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrParClass(par) { return par===3?'par3':par===5?'par5':'par4'; }
function lrTogParPicker() {
const p = document.getElementById('lrParPicker');
if(p) p.style.display = p.style.display==='none' ? 'flex' : 'none';
}
function lrSetPar(par) {
if(!lrState) return;
lrState.holes[lrState.curHole].par = par;
lrRenderHole();
_lrPersist();
}
function lrRelTopar(score,par){ return score!==null?score-par:null; }
function lrRelLabel(d){ if(d===null)return'\u2014';if(d<=-2)return'\u2212'+Math.abs(d);if(d===-1)return'\u22121';if(d===0)return'E';return'+'+d; }
function lrRelCls(d){ if(d===null)return'';if(d<=-2)return'sc-eagle';if(d===-1)return'sc-birdie';if(d===0)return'sc-par';if(d===1)return'sc-bogey';return'sc-double'; }
function lrSbbCls(d){ if(d===null)return'sbb-par';if(d<=-2)return'sbb-eagle';if(d===-1)return'sbb-birdie';if(d===0)return'sbb-par';if(d===1)return'sbb-bogey';return'sbb-double'; }

function lrStrokesOnHole(player, hole) {
// WHS stroke allocation: playing HCP vs hole handicap
if(!player.handicap||!hole.handicap) return 0;
const course = lrState.courseId ? courses.find(c=>c.id===lrState.courseId) : null;
const par = lrState.holes.reduce((t,h)=>t+h.par,0);
const hcpIdx = player.handicap;
const slope = parseFloat(lrState.slope)||113;
const rating = parseFloat(lrState.rating)||par;
const playHcp = Math.round(hcpIdx*(slope/113)+(rating-par));
let strokes = 0;
if(playHcp >= hole.handicap) strokes++;
if(playHcp >= 18 + hole.handicap) strokes++;
return strokes;
}

function lrNetScore(player, holeIdx) {
const s = player.scores[holeIdx];
if(s.score===null) return null;
const strokes = lrStrokesOnHole(player, lrState.holes[holeIdx]);
return s.score - strokes;
}

function lrStablefordPts(player, holeIdx) {
const net = lrNetScore(player, holeIdx);
const par = lrState.holes[holeIdx].par;
if(net===null) return null;
return Math.max(0, 2-(net-par));
}

function lrRunningTotal(playerIdx) {
const p = lrState.players[playerIdx];
const mode = lrState.mode;
let total=0, par=0, any=false;
lrState.holes.forEach((h,i)=>{
  const s = p.scores[i];
  if(s.score!==null){
    total+=s.score; par+=h.par; any=true;
  }
});
if(!any) return null;
return mode==='stableford' ? null : total-par;
}

function lrHasAnyHandicap() {
return lrState.players.some(p=>p.handicap!==null);
}

// \u2500\u2500 Render hole view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrRenderHole() {
if(!lrState) return;
const h   = lrState.holes[lrState.curHole];
const pc  = lrParClass(h.par);
const pi  = lrState.curPlayer;
const player = lrState.players[pi];
const s   = player.scores[lrState.curHole];
const mode = lrState.mode;
const shared = LR_MODES[mode]?.shared;

// Hole strip
const strip = document.getElementById('lrHoleStrip');
strip.className = 'lr-hole-strip '+pc;
const blk = document.getElementById('lrHoleBlk');
blk.className = 'lr-hole-blk '+pc;
const nEl = document.getElementById('lrHoleN');
nEl.className = 'lr-hole-n '+pc;
nEl.textContent = h.n;
document.getElementById('lrHoleInfo').innerHTML =
  `Par ${h.par}${h.yards?' \u00B7 '+h.yards+' yds':''} <span style="font-size:.5rem;opacity:.4;font-family:sans-serif">\u270E</span>`;
document.getElementById('lrHoleSi').textContent =
  h.handicap ? `SI ${h.handicap}` : '';
// Par picker \u2014 hide on hole change, highlight active par
const picker = document.getElementById('lrParPicker');
if(picker) {
  picker.style.display = 'none';
  picker.querySelectorAll('button[data-par]').forEach(b=>{
    const active = +b.dataset.par === h.par;
    b.style.background = active ? 'var(--ac2)' : '';
    b.style.borderColor = active ? 'var(--ac2)' : '';
    b.style.color = active ? '#fff' : '';
  });
}

// Net toggle
const netTog = document.getElementById('lrNetTog');
const hasHcp = lrHasAnyHandicap();
netTog.style.display = hasHcp ? '' : 'none';
document.getElementById('lrGrossBtn').className = lrState.netView ? '' : 'on';
document.getElementById('lrNetBtn').className   = lrState.netView ? 'on' : '';

// Header
document.getElementById('lrHdrTitle').textContent = lrState.courseName || 'GORDy Live Round';
document.getElementById('lrHdrMeta').textContent  =
  `H${lrState.curHole+1}/${lrState.holes.length} \u00B7 ${LR_MODES[mode]?.label||mode}`;

// Running score (me player or current)
const meIdx = lrState.players.findIndex(p=>p.isMe);
const dispIdx = meIdx>=0 ? meIdx : 0;
const rt = lrRunningTotal(dispIdx);
const rtEl = document.getElementById('lrRunning');
rtEl.textContent = rt!==null ? lrRelLabel(rt) : '\u2014';
rtEl.className   = 'lr-running '+(rt!==null?lrRelCls(rt):'');
document.getElementById('lrRunningLbl').textContent =
  mode==='stableford' ? 'pts' : 'vs par';

// Player tabs
const tabsEl = document.getElementById('lrPlayerTabs');
if(lrState.players.length > 1 && !shared) {
  tabsEl.style.display = 'flex';
  tabsEl.innerHTML = lrState.players.map((p,i)=>
    `<button class="lr-player-tab${i===pi?' active':''}" onclick="lrSetPlayer(${i})">${escHtml(p.name.split(' ')[0]||'P'+(i+1))}${p.isMe?' \u2605':''}</button>`
  ).join('');
} else {
  tabsEl.style.display = 'none';
}

// Score content
const scroll = document.getElementById('lrScroll');

/* G2 -- map mode branch. When map is active, replace the scroll with banner+map+collapsible scoring.
   Classic path (else) is untouched. */
if (lrState._mapOpen && _lrMapGeo) {
  scroll.innerHTML = _lrMapPanelHtml(h, pi, shared);
  setTimeout(function(){ _lrMapMount(); }, 0);
  /* Bottom-nav buttons live outside lrScroll so they stay visible as a persistent banner.
     G2b -- set full state (disabled + icon + label + class) matching classic path. */
  document.getElementById('lrPrevBtn').disabled = lrState.curHole === 0;
  var _lrMapIsLast = lrState.curHole === lrState.holes.length-1;
  document.getElementById('lrNextIcon').textContent = _lrMapIsLast ? '\u2713' : '\u2192';
  document.getElementById('lrNextLbl').textContent  = _lrMapIsLast ? 'Finish' : 'Next';
  document.getElementById('lrNextBtn').className    = 'lr-nav-btn primary' + (_lrMapIsLast ? ' sc-birdie' : '');
  return;
}

if(shared) {
  // Scramble / foursomes: one score for the team (use player 0)
  const ts = lrState.players[0].scores[lrState.curHole];
  scroll.innerHTML = lrScoreBlock(lrState.players[0], lrState.curHole, h, 0, true);
} else {
  scroll.innerHTML = lrScoreBlock(player, lrState.curHole, h, pi, false);
}

/* G2b-R -- Resume-map pill. Shown in classic view only when geometry is loaded
   for this round and the user has minimized the map. Tap restores map view. */
if (_lrMapGeo && lrState && !lrState._mapOpen) {
  scroll.innerHTML =
      '<div style="display:flex;justify-content:flex-end;margin-bottom:6px">'
    +   '<button class="btn" style="font-size:.6rem;padding:4px 12px;border-radius:16px" '
    +     'onclick="_lrMapResume()">\uD83D\uDDFA Resume map</button>'
    + '</div>' + scroll.innerHTML;
}

/* Phase 4: advanced mode collapsible */
scroll.innerHTML += _lrAdvancedHtml(lrState.curHole, shared ? 0 : pi, !!shared);

/* Caddie session companion */
scroll.innerHTML += _lrCaddieCompanionHtml();

// Tally strip
scroll.innerHTML += lrTallyStrip();

// Nav
document.getElementById('lrPrevBtn').disabled = lrState.curHole === 0;
const last = lrState.curHole === lrState.holes.length-1;
document.getElementById('lrNextIcon').textContent = last ? '\u2713' : '\u2192';
document.getElementById('lrNextLbl').textContent  = last ? 'Finish' : 'Next';
document.getElementById('lrNextBtn').className    =
  'lr-nav-btn primary'+(last?' sc-birdie':'');
}

function lrScoreBlock(player, holeIdx, hole, pi, shared) {
const s    = player.scores[holeIdx];
const diff = lrRelTopar(s.score, hole.par);
const netS = lrHasAnyHandicap() ? lrNetScore(player, holeIdx) : null;
const pts  = lrState.mode==='stableford' ? lrStablefordPts(player, holeIdx) : null;
const displayScore = (lrState.netView && netS!==null) ? netS : s.score;
const displayDiff  = (lrState.netView && netS!==null) ? lrRelTopar(netS, hole.par) : diff;
const label = shared ? 'Team Score' : 'Score';

const extraInfo = [
  netS!==null && !lrState.netView ? `Net: ${netS}` : '',
  pts!==null  ? `${pts} pt${pts!==1?'s':''}` : '',
].filter(Boolean).join(' \u00B7 ');

return `<div class="card" style="margin-bottom:0">
  <div class="card-title">${label}</div>
  <div class="lr-stepper" style="border-radius:8px;overflow:hidden">
    <button class="lr-step-btn" onclick="lrAdj(${pi},${holeIdx},'score',-1,${shared})">\u2212</button>
    <div class="lr-step-val">
      <div class="lr-step-num ${displayScore!==null?lrRelCls(displayDiff):''}">${displayScore!==null?displayScore:'\u2014'}</div>
      <div class="lr-step-rel ${displayScore!==null?lrRelCls(displayDiff):''}">${displayScore!==null?lrRelLabel(displayDiff):'tap to set'}</div>
      ${extraInfo?`<div style="font-size:.54rem;color:var(--tx3);margin-top:2px">${extraInfo}</div>`:''}
    </div>
    <button class="lr-step-btn" onclick="lrAdj(${pi},${holeIdx},'score',1,${shared})">+</button>
  </div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
  <div class="card" style="margin-bottom:0">
    <div class="card-title">Putts</div>
    <div class="lr-stepper">
      <button class="lr-step-btn sm" onclick="lrAdj(${pi},${holeIdx},'putts',-1,${shared})">\u2212</button>
      <div class="lr-step-val"><div class="lr-step-num sm">${s.putts!==null?s.putts:'\u2014'}</div></div>
      <button class="lr-step-btn sm" onclick="lrAdj(${pi},${holeIdx},'putts',1,${shared})">+</button>
    </div>
  </div>
  ${(()=>{ const _shots = s.shots||[]; const _hide = _lrAdvancedOpen && _shots.length > 0; return _hide ? '' : `
  <div class="card" style="margin-bottom:0">
    <div class="card-title">GIR</div>
    <div style="display:flex;gap:6px;margin-top:4px">
      <button class="lr-tog ${s.gir===true?'on-y':''}" style="flex:1" onclick="lrSetGir(${pi},${holeIdx},true,${shared})">\u2713 Yes</button>
      <button class="lr-tog ${s.gir===false?'on-n':''}" style="flex:1" onclick="lrSetGir(${pi},${holeIdx},false,${shared})">\u2717 No</button>
    </div>
    <div style="font-size:.54rem;color:var(--tx3);margin-top:6px">Reach in ${hole.par-2} stroke${hole.par-2!==1?'s':''}</div>
  </div>`; })()}
</div>
<div class="card" style="margin-bottom:0" id="lrNoteCard">
  <button class="notes-toggle" id="lrNoteToggle" onclick="lrToggleNote(${pi},${holeIdx})">\uD83D\uDCDD ${s.notes?s.notes.slice(0,40)+(s.notes.length>40?'\u2026':''):'Add a note\u2026'}</button>
  <textarea id="lrNoteInput" style="display:${s.notes||lrState._noteOpen?'block':'none'};width:100%;background:var(--bg);border:1px solid var(--gr2);border-radius:6px;color:var(--tx);font-family:'DM Mono',monospace;font-size:.72rem;padding:10px;outline:none;resize:none;margin-top:8px;min-height:70px" oninput="lrSaveNote(${pi},${holeIdx},this.value,${shared})">${s.notes||''}</textarea>
</div>`;
}

function lrTallyStrip() {
if(lrState.players.length < 2) return '';
const mode = lrState.mode;
const shared = LR_MODES[mode]?.shared;
const rows = shared
  ? lrState.teams.map(t=>{
      const p0 = lrState.players.find(p=>t.playerIds.includes(p.id));
      const rt = p0 ? lrRunningTotal(lrState.players.indexOf(p0)) : null;
      return `<div class="lr-tally-row"><span class="lr-tally-name">${escHtml(t.name)}</span><span class="lr-tally-score ${rt!==null?lrRelCls(rt):''}">${rt!==null?lrRelLabel(rt):'\u2014'}</span></div>`;
    })
  : lrState.players.map((p,i)=>{
      const rt = lrRunningTotal(i);
      return `<div class="lr-tally-row"><span class="lr-tally-name">${escHtml(p.name)}${p.isMe?' \u2605':''}</span><span class="lr-tally-score ${rt!==null?lrRelCls(rt):''}">${rt!==null?lrRelLabel(rt):'\u2014'}</span></div>`;
    });
return `<div class="lr-tally">${rows.join('')}</div>`;
}

// \u2500\u2500 Interaction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrAdj(pi, holeIdx, field, delta, shared) {
const targets = shared ? lrState.players : [lrState.players[pi]];
targets.forEach(p=>{
  const s = p.scores[holeIdx];
  if(field==='score'){
    s.score = Math.max(1, (s.score!==null?s.score:lrState.holes[holeIdx].par)+delta);
  } else {
    s.putts = Math.max(0, (s.putts!==null?s.putts:0)+delta);
  }
});
lrRenderHole();
_lrPersist();
}

function lrSetGir(pi, holeIdx, val, shared) {
const targets = shared ? lrState.players : [lrState.players[pi]];
targets.forEach(p=>{
  const s = p.scores[holeIdx];
  s.gir = s.gir===val ? null : val;
});
lrRenderHole();
_lrPersist();
}

function lrToggleNote(pi, holeIdx) {
lrState._noteOpen = !lrState._noteOpen;
lrRenderHole();
if(lrState._noteOpen) setTimeout(()=>document.getElementById('lrNoteInput')?.focus(),50);
}

function lrSaveNote(pi, holeIdx, val, shared) {
const targets = shared ? lrState.players : [lrState.players[pi]];
targets.forEach(p=>{ p.scores[holeIdx].notes = val; });
_lrPersist();
}

function lrSetPlayer(idx) {
lrState.curPlayer = idx;
lrState._noteOpen = false;
lrRenderHole();
}

function lrSetView(v) {
lrState.netView = v==='net';
lrRenderHole();
}

function lrSetNetView(v) { if(lrState) { lrState.netView=v; lrRenderTally(); } }

function lrGoHole(delta) {
const next = lrState.curHole + delta;
if(next < 0 || next >= lrState.holes.length) {
  if(delta > 0) lrEndRound();
  return;
}
lrState.curHole = next;
lrState.curPlayer = 0;
lrState._noteOpen = false;
/* Phase 4: clear advanced mode state on hole change */
_lrShotDraft        = null;
_lrEditingIndex     = null;
_lrObConfirmPending = false;
_lrDeleteConfirmIdx = null;
_lrGirPromptPending = false;
/* G2b-R -- reset per-hole aim + tee override. Map instance persists across holes. */
if (lrState) {
  lrState._mapAim = null;      /* midpoint recomputed on mount for new hole */
  lrState._mapTeeLonLat = null;
}
lrRenderHole();
_lrPersist();
/* G2b-R -- fly map to new hole + clear rendered aim line; marker will be replaced by _lrMapMount */
if (_lrMapInstance && _lrMapGeo) {
  _lrMapShowHole(lrState.curHole + 1);
  try { geomRenderPath(_lrMapInstance, []); } catch(e) {}
  /* remove old aim marker so _lrMapMount places a fresh one at new midpoint */
  if (_lrAimMarker) { try { _lrAimMarker.remove(); } catch(e) {} _lrAimMarker = null; }
}
/* G2b original (multi-waypoint):
if (lrState) { lrState._mapPath = []; lrState._mapTeeLonLat = null; }
lrRenderHole();
_lrPersist();
if (_lrMapInstance && _lrMapGeo) {
  _lrMapShowHole(lrState.curHole + 1);
  try { geomRenderPath(_lrMapInstance, []); } catch(e) {}
} */
}

// \u2500\u2500 Minimize / expand \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrMinimize() {
document.getElementById('lrOverlay').classList.remove('active');
lrUpdatePill();
}

function lrExpand() {
document.getElementById('lrOverlay').classList.add('active');
lrShowScreen('lrHoleScreen');
_lrMapRestoreFromStorage();  /* G2 -- rehydrate geometry if mapping was active */
lrRenderHole();
if (window.updateSessionPill) window.updateSessionPill();
}

function lrUpdatePill() {
const pill = document.getElementById('lrPill');
const floatPill = document.getElementById('lrFloatPill');
const liveDot = document.getElementById('hdrLiveDot');
if(!lrState || lrState.saved) {
  pill.classList.remove('visible');
  floatPill?.classList.remove('visible');
  liveDot?.classList.remove('visible');
  return;
}
const h = lrState.holes[lrState.curHole];
const meIdx = lrState.players.findIndex(p=>p.isMe);
const rt = meIdx>=0 ? lrRunningTotal(meIdx) : null;
const txt = `\u26F3 Live Round \u00B7 H${h.n} of ${lrState.holes.length}`;
const meta = [lrState.courseName, rt!==null?lrRelLabel(rt)+' vs par':''].filter(Boolean).join(' \u00B7 ');
// Rounds tab pill
pill.classList.add('visible');
document.getElementById('lrPillTxt').textContent = txt;
document.getElementById('lrPillMeta').textContent = meta;
/* lrFloatPill deprecated -- replaced by #sessionPill (Session C)
if(floatPill) {
  floatPill.classList.add('visible');
  document.getElementById('lrFloatTxt').textContent = txt;
  document.getElementById('lrFloatMeta').textContent = meta;
}
*/
// Header pulsing dot
liveDot?.classList.add('visible');
// Universal session pill (replaces deprecated lrFloatPill -- Session C)
if(window.updateSessionPill) window.updateSessionPill();
}

// \u2500\u2500 Tally view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrShowTally() {
lrRenderTally();
lrShowScreen('lrTallyScreen');
}
function lrShowTallyFromSummary() {
lrRenderTally();
lrShowScreen('lrTallyScreen');
}
function lrShowHole() {
lrShowScreen('lrHoleScreen');
lrRenderHole();
}

function lrRenderTally() {
const holesPlayed = lrState.holes;
const mode = lrState.mode;
const net  = lrState.netView && lrHasAnyHandicap();

// Build table header
const playerCols = LR_MODES[mode]?.shared
  ? lrState.teams.map(t=>escHtml(t.name))
  : lrState.players.map(p=>escHtml(p.name.split(' ')[0]||'P'));

let html = `<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:.65rem">
  <thead><tr style="border-bottom:2px solid var(--br)">
    <th style="padding:5px 6px;text-align:left;color:var(--tx3);font-weight:400;font-size:.54rem;text-transform:uppercase;letter-spacing:.08em">H</th>
    <th style="padding:5px 6px;text-align:center;color:var(--tx3);font-weight:400;font-size:.54rem">Par</th>
    <th style="padding:5px 6px;text-align:center;color:var(--tx3);font-weight:400;font-size:.54rem">Yds</th>
    ${playerCols.map(n=>`<th style="padding:5px 6px;text-align:center;color:var(--tx3);font-weight:400;font-size:.54rem">${n}</th>`).join('')}
  </tr></thead>
  <tbody>`;

let frontScore=[], backScore=[];
lrState.players.forEach(()=>{ frontScore.push(0); backScore.push(0); });

holesPlayed.forEach((h,hi)=>{
  const rowBg = h.par===3?'background:var(--sky2)':h.par===5?'background:var(--sand2)':'';
  const scores = LR_MODES[mode]?.shared
    ? [lrState.players[0].scores[hi]] // team shared
    : lrState.players.map(p=>p.scores[hi]);

  const cells = scores.map((s,pi)=>{
    const disp = net ? lrNetScore(lrState.players[pi],hi) : s.score;
    const diff = lrRelTopar(disp, h.par);
    if(disp!==null) hi<9 ? (frontScore[pi]+=disp) : (backScore[pi]+=disp);
    return `<td style="padding:5px 6px;text-align:center"><span class="sbb ${lrSbbCls(diff)}">${disp!==null?disp:'\u2014'}</span></td>`;
  }).join('');

  html += `<tr style="${rowBg};border-bottom:1px solid var(--br)">
    <td style="padding:5px 6px;font-weight:700;color:var(--tx)">${h.n}</td>
    <td style="padding:5px 6px;text-align:center;color:var(--tx2)">${h.par}</td>
    <td style="padding:5px 6px;text-align:center;color:var(--tx3)">${h.yards||'\u2014'}</td>
    ${cells}
  </tr>`;

  // OUT subtotal after hole 9
  if(h.n===9) {
    const frontPar = holesPlayed.slice(0,9).reduce((t,x)=>t+x.par,0);
    html += `<tr style="background:var(--gr3);border-bottom:1px solid var(--gr2)">
      <td colspan="3" style="padding:5px 8px;font-size:.58rem;font-weight:600;color:var(--ac2);text-align:right">OUT</td>
      ${lrState.players.map((_,pi)=>{
        const v=frontScore[pi]; const d=v?v-frontPar:null;
        return `<td style="padding:5px 6px;text-align:center;font-weight:600;color:var(--ac2)">${v||'\u2014'}</td>`;
      }).join('')}
    </tr>`;
  }
});

// IN + TOTAL
const totalPar = holesPlayed.reduce((t,h)=>t+h.par,0);
const frontPar = holesPlayed.slice(0,9).reduce((t,h)=>t+h.par,0);
const backPar  = totalPar - frontPar;
const hasBack  = holesPlayed.some(h=>h.n>9);

if(hasBack) {
  html += `<tr style="background:var(--gr3);border-bottom:1px solid var(--gr2)">
    <td colspan="3" style="padding:5px 8px;font-size:.58rem;font-weight:600;color:var(--ac2);text-align:right">IN</td>
    ${lrState.players.map((_,pi)=>{const v=backScore[pi];return`<td style="padding:5px 6px;text-align:center;font-weight:600;color:var(--ac2)">${v||'\u2014'}</td>`;}).join('')}
  </tr>`;
}
html += `<tr style="background:var(--ac2);color:#fff">
  <td colspan="3" style="padding:5px 8px;font-size:.58rem;font-weight:700;text-align:right">TOTAL</td>
  ${lrState.players.map((_,pi)=>{
    const v=(frontScore[pi]||0)+(backScore[pi]||0);
    return `<td style="padding:5px 6px;text-align:center;font-weight:700">${v||'\u2014'}</td>`;
  }).join('')}
</tr>`;

html += `</tbody></table></div>`;

if(lrHasAnyHandicap()) {
  html += `<div style="display:flex;gap:6px;margin-top:10px">
    <button class="btn sec" style="font-size:.6rem" onclick="lrSetNetView(false)">Gross</button>
    <button class="btn sec" style="font-size:.6rem" onclick="lrSetNetView(true)">Net</button>
  </div>`;
}
document.getElementById('lrTallyContent').innerHTML = html;

/* SG tally row -- me player only */
var _lrTallyMeIdx = lrState.players.findIndex(function(p) { return p.isMe; });
if (_lrTallyMeIdx >= 0) {
  var _lrTallySG = _lrRoundSG(lrState.players[_lrTallyMeIdx].scores, lrState.holes);
  var _lrTallySGHasData = lrState.players[_lrTallyMeIdx].scores.some(function(s) {
    return s.shots && s.shots.some(function(sh) { return sh.sg !== null && sh.sg !== undefined; });
  });
  var _lrTallySGVal = _lrTallySGHasData
    ? '<span style="color:' + _lrSGColor(_lrTallySG.total) + ';font-weight:600">'
      + (_lrTallySG.total >= 0 ? '+' : '\u2212') + Math.abs(_lrTallySG.total).toFixed(2) + '</span>'
    : '\u2014';
  document.getElementById('lrTallyContent').innerHTML +=
    '<div style="display:flex;justify-content:space-between;align-items:center;'
    + 'padding:8px 6px;margin-top:8px;border-top:1px solid var(--br);font-size:.65rem">'
    + '<span style="color:var(--tx3);text-transform:uppercase;letter-spacing:.08em;font-size:.54rem">SG Total</span>'
    + _lrTallySGVal + '</div>';
}
}

// \u2500\u2500 End round \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrCancelEndBanner() {
const banner = document.getElementById('lrEndBanner');
if(banner) banner.style.display = 'none';
// Old rewire logic removed -- End Round button no longer gets dynamically reassigned:
// const confirmBtn = banner.querySelector('.btn.danger');
// if(confirmBtn) { confirmBtn.textContent = 'End Round'; confirmBtn.onclick = lrConfirmEnd; }
}
function lrEndRound() {
const played = lrState.holes.filter((_,i)=>lrState.players.some(p=>p.scores[i]?.score!==null)).length;
const banner = document.getElementById('lrEndBanner');
const msg = document.getElementById('lrEndBannerMsg');
if(msg) msg.textContent = played < lrState.holes.length
  ? `End after hole ${lrState.holes[lrState.curHole].n}? ${lrState.holes.length-played} hole(s) will be blank.`
  : 'End round and go to summary?';
if(banner) banner.style.display='block';
}
function lrConfirmEnd() {
const banner = document.getElementById('lrEndBanner');
if(banner) banner.style.display='none';
lrShowScreen('lrSummaryScreen');
lrRenderSummary();
}

function lrRenderSummary() {
const meIdx = lrState.players.findIndex(p=>p.isMe);
const me    = meIdx>=0 ? lrState.players[meIdx] : lrState.players[0];
const totalScore = me.scores.reduce((t,s)=>t+(s.score||0),0);
const totalPar   = lrState.holes.reduce((t,h)=>t+h.par,0);
const played     = me.scores.filter(s=>s.score!==null).length;
const diff       = played ? totalScore-totalPar : null;
const totalPutts = me.scores.reduce((t,s)=>t+(s.putts||0),0);
const girCount   = me.scores.filter(s=>s.gir===true).length;
const girOf      = me.scores.filter(s=>s.gir!==null).length;

document.getElementById('lrSumScore').textContent = played ? totalScore : '\u2014';
document.getElementById('lrSumScore').className   = 'lrSumScore '+(played?lrRelCls(diff):'');
document.getElementById('lrSumMeta').textContent  =
  [lrState.courseName, lrState.tee?lrState.tee+' tees':'', played+' holes'].filter(Boolean).join(' \u00B7 ');

document.getElementById('lrSumStats').innerHTML = [
  {lbl:'vs Par', val:diff!==null?lrRelLabel(diff):'\u2014', cls:diff!==null?lrRelCls(diff):''},
  {lbl:'Putts',  val:totalPutts||'\u2014', cls:''},
  {lbl:'GIR',    val:girOf?`${girCount}/${girOf}`:'\u2014', cls:''},
].map(x=>`<div style="text-align:center">
  <div style="font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:600;color:var(--ac2)" class="${x.cls}">${x.val}</div>
  <div style="font-size:.52rem;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;margin-top:2px">${x.lbl}</div>
</div>`).join('<div style="width:1px;background:var(--br);margin:0 6px"></div>');

// Leaderboard
const sorted = [...lrState.players].sort((a,b)=>{
  const as=a.scores.reduce((t,s)=>t+(s.score||0),0);
  const bs=b.scores.reduce((t,s)=>t+(s.score||0),0);
  return as-bs;
});
document.getElementById('lrSumLeaderboard').innerHTML = lrState.players.length>1
  ? `<div class="card" style="margin-bottom:0"><div class="card-title">Leaderboard</div>
  ${sorted.map((p,pos)=>{
    const sc=p.scores.reduce((t,s)=>t+(s.score||0),0);
    const par=lrState.holes.reduce((t,h)=>t+h.par,0);
    const d=sc?sc-par:null;
    return `<div class="lr-tally-row">
      <span style="font-size:.6rem;color:var(--tx3);width:18px">${pos+1}.</span>
      <span class="lr-tally-name">${escHtml(p.name)}${p.isMe?' \u2605':''}</span>
      <span class="lr-tally-score ${d!==null?lrRelCls(d):''}">${sc||'\u2014'}</span>
      <span style="font-size:.6rem;color:var(--tx3);min-width:28px;text-align:right">${d!==null?lrRelLabel(d):''}</span>
    </div>`;
  }).join('')}</div>` : '';

/* SG summary card */
(function() {
  var _sgMe = meIdx >= 0 ? lrState.players[meIdx] : null;
  if (!_sgMe) return;
  var _sgData = _lrRoundSG(_sgMe.scores, lrState.holes);
  var _sgHasData = _sgMe.scores.some(function(s) {
    return s.shots && s.shots.some(function(sh) { return sh.sg !== null && sh.sg !== undefined; });
  });
  if (!_sgHasData) return;
  function _sgFmt(v) {
    return '<span style="color:' + _lrSGColor(v) + '">'
      + (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(2) + '</span>';
  }
  var _firData = _lrRoundFIR(_sgMe.scores, lrState.holes);
  var _girHit = _sgMe.scores.filter(function(s) { return s.gir === true; }).length;
  var _girElig = _sgMe.scores.filter(function(s) { return s.gir !== null && s.gir !== undefined; }).length;
  var _firGirLine = '';
  if (_firData.eligible > 0 || _girElig > 0) {
    var _firStr = _firData.eligible > 0
      ? 'FIR: ' + _firData.hit + '/' + _firData.eligible
        + ' (' + Math.round((_firData.pct || 0) * 100) + '%)'
      : '';
    var _girStr = _girElig > 0
      ? 'GIR: ' + _girHit + '/' + _girElig
        + ' (' + Math.round(_girHit / _girElig * 100) + '%)'
      : '';
    _firGirLine = [_firStr, _girStr].filter(Boolean).join(' \u00B7 ');
  }
  var _sgCard = '<details style="margin-top:10px"><summary style="cursor:pointer;'
    + 'color:var(--tx3);padding:8px 0;'
    + 'border-top:1px solid var(--br);list-style:none;display:flex;justify-content:space-between;align-items:center">'
    + '<span style="font-size:.8rem;font-weight:600">Strokes Gained</span>'
    + '<span style="color:' + _lrSGColor(_sgData.total) + ';font-size:.8rem;font-weight:700">'
    + (_sgData.total >= 0 ? '+' : '\u2212') + Math.abs(_sgData.total).toFixed(2) + '</span>'
    + '</summary>'
    + '<div class="card" style="margin-top:6px;margin-bottom:0">'
    + '<table style="width:100%;border-collapse:collapse;font-size:.65rem">'
    + '<tr style="border-bottom:1px solid var(--br)"><td style="padding:5px 2px;color:var(--tx2)">Off the Tee</td><td style="text-align:right;padding:5px 2px">' + _sgFmt(_sgData.OTT) + '</td></tr>'
    + '<tr style="border-bottom:1px solid var(--br)"><td style="padding:5px 2px;color:var(--tx2)">Approach</td><td style="text-align:right;padding:5px 2px">' + _sgFmt(_sgData.APP) + '</td></tr>'
    + '<tr style="border-bottom:1px solid var(--br)"><td style="padding:5px 2px;color:var(--tx2)">Around the Green</td><td style="text-align:right;padding:5px 2px">' + _sgFmt(_sgData.ARG) + '</td></tr>'
    + '<tr><td style="padding:5px 2px;color:var(--tx2)">Putting</td><td style="text-align:right;padding:5px 2px">' + _sgFmt(_sgData.PUTT) + '</td></tr>'
    + '</table>'
    + (_firGirLine ? '<div style="margin-top:8px;font-size:.6rem;color:var(--tx3)">' + _firGirLine + '</div>' : '')
    + '</div></details>';
  document.getElementById('lrSumLeaderboard').innerHTML += _sgCard;
})();

// Save note
const noteEl = document.getElementById('lrSaveNote');
if(meIdx<0) {
  noteEl.innerHTML = '\u26A0 No player marked as you \u2014 round will be saved without handicap eligibility. <a href="#" onclick="event.preventDefault();lrShowScreen(\'lrHoleScreen\');lrRenderHole()">Go back to mark yourself.</a>';
} else {
  const hasSI = lrState.holes.every(h=>h.handicap>0);
  const capNote = lrState.countForHandicap && me?.handicap && hasSI
    ? ' Net double bogey cap applied per hole for differential.' : '';
  noteEl.textContent = lrState.countForHandicap
    ? 'Your score will be saved and counted toward your handicap.'+capNote
    : 'Your score will be saved but excluded from handicap calculation.';
}
}

// \u2500\u2500 Save \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrCalcDiffWithCap(meIdx) {
// Returns {diff, capped} where capped=true means net double bogey was applied
const me = lrState.players[meIdx];
const rating = parseFloat(lrState.rating);
const slope  = parseFloat(lrState.slope);
if(!rating || !slope) return {diff: null, capped: false};

const hasSI = lrState.holes.every(h=>h.handicap>0);
if(!hasSI || !me.handicap) {
  // No SI data \u2014 fall back to raw total
  const total = me.scores.reduce((t,s)=>t+(s.score||0),0);
  return {diff: total ? calcDiff(total, rating, slope) : null, capped: false};
}

// Apply net double bogey cap per hole
let cappedTotal = 0, anyCapped = false;
lrState.holes.forEach((h,i)=>{
  const s = me.scores[i];
  if(s.score===null) return;
  const strokes = lrStrokesOnHole(me, h);
  const maxScore = h.par + 2 + strokes; // net double bogey
  const actual = s.score;
  const used   = Math.min(actual, maxScore);
  if(used < actual) anyCapped = true;
  cappedTotal += used;
});
const diff = calcDiff(cappedTotal, rating, slope);
return {diff, capped: anyCapped};
}
function lrSaveRound() {
if(lrState.saved) { document.getElementById('lrSaveStatus').textContent='Already saved.'; return; }
const meIdx = lrState.players.findIndex(p=>p.isMe);
const me    = meIdx>=0 ? lrState.players[meIdx] : null;
/* Phase 4b: ensure SG written on all holes before saving */
if (me) me.scores.forEach(function(s) { _lrWriteSG(s); });
const totalScore = me ? me.scores.reduce((t,s)=>t+(s.score||0),0) : null;
const par        = lrState.holes.reduce((t,h)=>t+h.par,0);
const {diff, capped} = meIdx>=0 ? lrCalcDiffWithCap(meIdx) : {diff:null, capped:false};

const newRound = {
  id: uid(),
  date: lrState.date,
  courseName: lrState.courseName,
  tee: lrState.tee||'',
  rating: lrState.rating||'',
  slope: lrState.slope||'',
  par: String(par),
  score: totalScore ? String(totalScore) : '',
  diff,
  notes: lrState.conditions !== 'calm' ? lrState.conditions : '',
  countForHandicap: me ? lrState.countForHandicap : false,
  sessionIds: [],
  holes: me ? me.scores.map((s,i)=>({
    n: lrState.holes[i].n,
    par: String(lrState.holes[i].par),
    yards: String(lrState.holes[i].yards||''),
    score: s.score!==null?String(s.score):'',
    putts: s.putts!==null?String(s.putts):'',
    gir: s.gir,
    notes: s.notes||'',
    /* Phase 4 additive fields */
    fir:               s.fir               !== undefined ? s.fir               : null,
    shots:             s.shots             || [],
    on_green_distance: s.on_green_distance !== undefined ? s.on_green_distance : null,
    chip_putt_count:   s.chip_putt_count   !== undefined ? s.chip_putt_count   : null,
    holed_out:         s.holed_out         || false,
  })).filter(h=>h.score) : [],
  players: lrState.players.map(p=>({
    name: p.name,
    isMe: p.isMe,
    handicap: p.handicap,
    score: p.scores.reduce((t,s)=>t+(s.score||0),0) || null,
  })),
};

/* rounds = [newRound, ...rounds]; */ rounds.unshift(newRound);
save();
if (window.syncSave) window.syncSave();
renderHandicap();
lrState.saved = true;
if (window.clearActiveSession) window.clearActiveSession('round');
const st = document.getElementById('lrSaveStatus');
st.style.color = 'var(--ac)';
st.textContent = '\u2713 Round saved.'+(capped?' Max score (net double bogey) applied to differential.':'');
const closeBtn = document.getElementById('lrCloseBtn');
if(closeBtn) closeBtn.style.display = '';
lrUpdatePill();
}

// \u2500\u2500 PDF export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// -- Shared PDF helpers -------------------------------------------------------
var _pdfFontsLink = '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">';

function _pdfSharedCSS() {
  return '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0;}'
    + 'body{font-family:\'DM Mono\',monospace,sans-serif;background:#f4efe6;color:#2c3a28;padding:24px;max-width:900px;margin:0 auto;font-size:.76rem;line-height:1.4;}'
    + '@media print{body{background:#fff;padding:10px;font-size:.7rem;}.no-print{display:none;}.page-break{page-break-before:always;}[contenteditable]{outline:none;border-bottom:1px solid #ccc;min-height:1em;}}'
    + '.pdf-banner{display:flex;justify-content:space-between;align-items:center;padding:10px 0 12px;border-bottom:2px solid #3d6b35;margin-bottom:14px;}'
    + '.pdf-banner-left{display:flex;align-items:center;gap:10px;}'
    + '.pdf-banner-logo{width:32px;height:32px;border-radius:6px;}'
    + '.pdf-banner-title{font-family:\'Playfair Display\',serif;font-size:1rem;font-weight:700;color:#2d5127;letter-spacing:-.01em;}'
    + '.pdf-banner-sub{font-size:.52rem;letter-spacing:.18em;text-transform:uppercase;color:#8a9e82;margin-top:2px;}'
    + '.pdf-banner-right{text-align:right;}'
    + '.pdf-banner-player{font-size:.72rem;font-weight:600;color:#2c3a28;}'
    + '.pdf-banner-hcp{font-size:.56rem;color:#8a9e82;letter-spacing:.06em;margin-top:2px;}'
    + '.hero{background:linear-gradient(135deg,#e8f0e5,#fff);border:2px solid #3d6b35;border-radius:8px;padding:14px 18px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}'
    + '.hero-title{font-family:\'Playfair Display\',serif;font-size:1.1rem;font-weight:700;color:#2d5127;}'
    + '.hero-meta{font-size:.6rem;color:#8a9e82;margin-top:3px;}'
    + '.card{background:#fff;border:1px solid #ddd5c4;border-radius:6px;padding:12px 14px;margin-bottom:10px;}'
    + 'h3{font-size:.54rem;letter-spacing:.16em;text-transform:uppercase;color:#8a9e82;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ddd5c4;}'
    + 'table{width:100%;border-collapse:collapse;}'
    + 'td,th{padding:3px 6px;border-bottom:1px solid #f0ebe0;vertical-align:middle;}'
    + 'th{font-size:.52rem;letter-spacing:.1em;text-transform:uppercase;color:#8a9e82;font-weight:400;border-bottom:2px solid #ddd5c4;}'
    + '.footer{text-align:center;font-size:.52rem;color:#8a9e82;margin-top:16px;letter-spacing:.1em;text-transform:uppercase;}'
    + '.print-btn{display:inline-block;margin-bottom:12px;padding:5px 14px;background:#3d6b35;color:#fff;border:none;border-radius:4px;font-family:monospace;font-size:.68rem;cursor:pointer;letter-spacing:.04em;}'
    + '.page-break{page-break-before:always;}'
    + '</style>';
}

function _pdfBanner(playerName, hcp, logoDataUrl) {
  var right = playerName
    ? '<div class="pdf-banner-right">'
      + '<div class="pdf-banner-player">' + escHtml(playerName) + '</div>'
      + '<div class="pdf-banner-hcp">HCP ' + (hcp !== null && hcp !== undefined ? escHtml(String(hcp)) : '\u2014') + '</div>'
      + '</div>'
    : '';
  var logoImg = logoDataUrl
    ? '<img src="' + logoDataUrl + '" class="pdf-banner-logo" alt="Gordy">'
    : '';
  return '<div class="pdf-banner">'
    + '<div class="pdf-banner-left">'
    + logoImg
    + '<div><div class="pdf-banner-title">Gordy</div>'
    + '<div class="pdf-banner-sub">The Virtual Caddy</div></div>'
    + '</div>'
    + right + '</div>';
}

async function _pdfLogoDataUrl() {
  return new Promise(function(res) {
    var link = document.querySelector('link[rel="apple-touch-icon"]');
    if (!link) { res(''); return; }
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      try {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth || 192;
        c.height = img.naturalHeight || 192;
        c.getContext('2d').drawImage(img, 0, 0);
        res(c.toDataURL('image/png'));
      } catch(e) { res(''); }
    };
    img.onerror = function() { res(''); };
    img.src = link.href;
  });
}

/* Build caddie session section for PDF (bag + full hole-by-hole table) */
function _lrPdfCaddieSessionHtml(sid) {
  var data = _lrParseSession(sid);
  if (!data) return '';
  var out = '';
  if (data.bagLines && data.bagLines.length) {
    var bRows = data.bagLines.map(function(l) {
      var m = l.match(/^(\d+)\.\s+(.+?)\s+\u2014\s+([0-9\u2013\-]+ yds)\s+(.+)/);
      if (!m) return '<tr><td colspan="4" style="color:#5a6e52">' + escHtml(l) + '</td></tr>';
      return '<tr><td style="color:#2d5127;font-weight:600;width:24px">' + escHtml(m[1]) + '.</td>'
        + '<td>' + escHtml(m[2]) + '</td>'
        + '<td style="text-align:center;color:#3d6b35;white-space:nowrap">' + escHtml(m[3]) + '</td>'
        + '<td style="color:#5a6e52;font-size:.63rem">' + escHtml(m[4]) + '</td></tr>';
    }).join('');
    out += '<div class="card"><h3>Optimised Bag</h3>'
      + '<table><thead><tr><th>#</th><th>Club</th><th style="text-align:center">Range</th><th>Role</th></tr></thead>'
      + '<tbody>' + bRows + '</tbody></table></div>';
  }
  var hKeys = Object.keys(data.holeMap).map(Number).sort(function(a,b){return a-b;});
  if (hKeys.length) {
    var hRows = hKeys.map(function(k) {
      var h = data.holeMap[k];
      var parN = parseInt(h.par)||0;
      var bg = parN===3?'#edf3f7':parN===5?'#fff8ee':'#fff';
      return '<tr style="background:' + bg + '">'
        + '<td style="text-align:center;font-weight:700;color:#2d5127">' + escHtml(String(h.num||k)) + '</td>'
        + '<td style="text-align:center">' + escHtml(h.par||'\u2014') + '</td>'
        + '<td style="text-align:center">' + escHtml(h.yds||'\u2014') + '</td>'
        + '<td style="font-size:.62rem;color:#3d6b35">' + escHtml(h.strokes||'') + '</td>'
        + '<td style="font-size:.62rem">' + escHtml(h.advice||'') + '</td></tr>';
    }).join('');
    out += '<div class="card page-break"><h3>Hole-by-Hole Advice</h3>'
      + '<table><thead><tr>'
      + '<th style="width:32px;text-align:center">H</th>'
      + '<th style="width:28px;text-align:center">Par</th>'
      + '<th style="width:40px;text-align:center">Yds</th>'
      + '<th style="width:80px">Strokes</th>'
      + '<th>Advice</th></tr></thead>'
      + '<tbody>' + hRows + '</tbody></table></div>';
  }
  return out;
}

/* Build SG summary + hole-by-hole breakdown for PDF */
function _lrPdfSGHtml(mePlayer, holes) {
  var hasSG = mePlayer.scores.some(function(s) {
    return s.shots && s.shots.some(function(sh) { return sh.sg !== null && sh.sg !== undefined; });
  });
  if (!hasSG) return '';
  var sg  = _lrRoundSG(mePlayer.scores, holes);
  var fir = _lrRoundFIR(mePlayer.scores, holes);
  var girHit = holes.filter(function(h,i) { return mePlayer.scores[i] && mePlayer.scores[i].gir === true; }).length;
  var girOf  = holes.filter(function(h,i) { return mePlayer.scores[i] && mePlayer.scores[i].gir !== null && mePlayer.scores[i].gir !== undefined; }).length;
  function sgC(v) { return v > 0 ? '#3d6b35' : v < 0 ? '#a03030' : '#8a9e82'; }
  function sgF(v) { return (v > 0 ? '+' : '') + v.toFixed(2); }

  var summary = '<div class="card">'
    + '<h3>Strokes Gained \u2014 Summary</h3>'
    + '<div style="font-size:1.1rem;font-weight:700;color:' + sgC(sg.total) + ';margin-bottom:8px">SG Total: ' + sgF(sg.total) + '</div>'
    + '<table><thead><tr>'
    + '<th style="text-align:center">OTT</th><th style="text-align:center">APP</th>'
    + '<th style="text-align:center">ARG</th><th style="text-align:center">PUTT</th>'
    + '</tr></thead><tbody><tr>'
    + '<td style="text-align:center;color:' + sgC(sg.OTT)  + ';font-weight:600">' + sgF(sg.OTT)  + '</td>'
    + '<td style="text-align:center;color:' + sgC(sg.APP)  + ';font-weight:600">' + sgF(sg.APP)  + '</td>'
    + '<td style="text-align:center;color:' + sgC(sg.ARG)  + ';font-weight:600">' + sgF(sg.ARG)  + '</td>'
    + '<td style="text-align:center;color:' + sgC(sg.PUTT) + ';font-weight:600">' + sgF(sg.PUTT) + '</td>'
    + '</tr></tbody></table>'
    + '<div style="font-size:.6rem;color:#8a9e82;margin-top:8px">'
    + 'FIR: ' + fir.hit + '/' + fir.eligible
    + (fir.pct !== null ? ' (' + Math.round(fir.pct * 100) + '%)' : '')
    + ' \u00B7 GIR: ' + girHit + '/' + girOf
    + (girOf > 0 ? ' (' + Math.round(girHit / girOf * 100) + '%)' : '')
    + '</div></div>';

  var hbhRows = holes.map(function(hole, i) {
    var s = mePlayer.scores[i];
    if (!s) return '';
    var hsg = _lrAggregateSG(s.shots || [], hole.par);
    var bg  = hole.par===3?'#edf3f7':hole.par===5?'#fff8ee':'#fff';
    var d   = s.score !== null ? s.score - hole.par : null;
    var dCls = d===null?'':d<=-2?'color:#c8860a':d===-1?'color:#3d6b35':d===1?'color:#b89a5a':d>=2?'color:#a03030':'';
    var hasHoleSG = !!(s.shots && s.shots.some(function(sh) { return sh.sg !== null && sh.sg !== undefined; }));
    return '<tr style="background:' + bg + '">'
      + '<td style="text-align:center;font-weight:700">' + hole.n + '</td>'
      + '<td style="text-align:center">' + hole.par + '</td>'
      + '<td style="text-align:center;' + dCls + ';font-weight:' + (d!==null&&d<0?'700':'400') + '">' + (s.score!==null?s.score:'\u2014') + '</td>'
      + '<td style="text-align:center;color:' + sgC(hsg.OTT)  + '">' + (hasHoleSG?sgF(hsg.OTT) :'\u2014') + '</td>'
      + '<td style="text-align:center;color:' + sgC(hsg.APP)  + '">' + (hasHoleSG?sgF(hsg.APP) :'\u2014') + '</td>'
      + '<td style="text-align:center;color:' + sgC(hsg.ARG)  + '">' + (hasHoleSG?sgF(hsg.ARG) :'\u2014') + '</td>'
      + '<td style="text-align:center;color:' + sgC(hsg.PUTT) + '">' + (hasHoleSG?sgF(hsg.PUTT):'\u2014') + '</td>'
      + '<td style="text-align:center;color:' + sgC(hsg.total) + ';font-weight:600">' + (hasHoleSG?sgF(hsg.total):'\u2014') + '</td>'
      + '</tr>';
  }).join('');

  var breakdown = '<div class="card">'
    + '<h3>Strokes Gained \u2014 Hole by Hole</h3>'
    + '<table><thead><tr>'
    + '<th style="text-align:center">H</th><th style="text-align:center">Par</th><th style="text-align:center">Score</th>'
    + '<th style="text-align:center">OTT</th><th style="text-align:center">APP</th>'
    + '<th style="text-align:center">ARG</th><th style="text-align:center">PUTT</th>'
    + '<th style="text-align:center">Total</th>'
    + '</tr></thead><tbody>' + hbhRows + '</tbody></table></div>';

  return summary + breakdown;
}

async function lrExportPdf(exportMode) {
const logo     = await _pdfLogoDataUrl();
const players  = lrState.players;
const holes    = lrState.holes;
const hasHcp   = lrHasAnyHandicap();
const mode     = LR_MODES[lrState.mode]?.label || lrState.mode;
const totalPar = holes.reduce((t,h)=>t+h.par,0);
const mePlayer = players.find(p=>p.isMe) || players[0] || null;
const meName   = mePlayer ? mePlayer.name : '';
const meHcp    = mePlayer ? mePlayer.handicap : null;

function scoreRow(hole, scores, net) {
  const bg = hole.par===3?'#edf3f7':hole.par===5?'#fff8ee':'#fff';
  const cells = scores.map(s=>{
    const disp = net&&s.netScore!==null?s.netScore:s.score;
    const d = disp!==null?disp-hole.par:null;
    const cls = d===null?'':d<=-2?'color:#c8860a':d===-1?'color:#3d6b35':d===1?'color:#b89a5a':d>=2?'color:#a03030':'';
    return `<td style="text-align:center;${cls};font-weight:${d!==null&&d<0?'700':'400'}">${disp!==null?disp:'\u2014'}</td>`;
  }).join('');
  return `<tr style="background:${bg}">\n<td style="text-align:center;font-weight:700">${hole.n}</td><td style="text-align:center">${hole.par}</td><td style="text-align:center;color:#8a9e82">${hole.yards||'\u2014'}</td>${cells}\n</tr>`;
}

function buildScores(net) {
  return holes.map(h=>{
    const ss = players.map(p=>{
      const s = p.scores[holes.indexOf(h)];
      const ns = hasHcp ? lrNetScore(p, holes.indexOf(h)) : null;
      return {score:s.score, netScore:ns};
    });
    return scoreRow(h, ss, net);
  });
}

function subRow(label, scores) {
  return `<tr style="background:#e8f0e5;font-weight:600;font-size:.58rem">
    <td colspan="3" style="text-align:right;padding:4px 7px;color:#2d5127">${label}</td>
    ${scores.map(v=>`<td style="text-align:center;color:#2d5127">${v||'\u2014'}</td>`).join('')}
  </tr>`;
}

function buildTable(net, label) {
  const front = holes.filter(h=>h.n<=9);
  const back  = holes.filter(h=>h.n>9);
  const rows  = buildScores(net).join('');
  const frontTotals = players.map(p=>{
    return front.reduce((t,h)=>{
      const s=p.scores[holes.indexOf(h)];
      const v=net?(lrNetScore(p,holes.indexOf(h))||0):( s.score||0);
      return t+v;
    },0);
  });
  const backTotals = players.map(p=>{
    return back.reduce((t,h)=>{
      const s=p.scores[holes.indexOf(h)];
      const v=net?(lrNetScore(p,holes.indexOf(h))||0):(s.score||0);
      return t+v;
    },0);
  });
  const totals = players.map((_,i)=>(frontTotals[i]||0)+(backTotals[i]||0));

  const outRow = front.length ? subRow('OUT',frontTotals) : '';
  const inRow  = back.length  ? subRow('IN', backTotals)  : '';
  const totRow = `<tr style="background:#2d5127;color:#fff;font-weight:700">
    <td colspan="3" style="text-align:right;padding:4px 7px;font-size:.6rem">TOTAL</td>
    ${totals.map(v=>`<td style="text-align:center">${v||'\u2014'}</td>`).join('')}
  </tr>`;

  const phCols = players.map(p=>`<th style="text-align:center">${escHtml(p.name.split(' ')[0]||'P')}</th>`).join('');
  return `<div class="card"><h3>${label}</h3>
  <table><thead><tr><th style="text-align:center">H</th><th style="text-align:center">Par</th><th style="text-align:center">Yds</th>${phCols}</tr></thead>
  <tbody>${rows}${outRow}${inRow}${totRow}</tbody></table></div>`;
}

const leaderboard = [...players].sort((a,b)=>{
  return a.scores.reduce((t,s)=>t+(s.score||0),0) - b.scores.reduce((t,s)=>t+(s.score||0),0);
}).map((p,i)=>{
  const sc=p.scores.reduce((t,s)=>t+(s.score||0),0);
  const d=sc?sc-totalPar:null;
  return `<tr><td>${i+1}</td><td>${escHtml(p.name)}${p.isMe?' \u2605':''}</td><td style="text-align:center">${sc||'\u2014'}</td><td style="text-align:center;color:${d&&d<0?'#3d6b35':d&&d>0?'#a03030':'#2c3a28'}">${d!==null?lrRelLabel(d):'\u2014'}</td><td style="text-align:center">${p.handicap||'\u2014'}</td></tr>`;
}).join('');

// -- Advanced prefix: caddie session + SG analysis --
var advancedPrefix = '';
if (exportMode === 'advanced' && mePlayer) {
  var _sid = lrState.linkedSessionId || null;
  var _cHtml = _sid ? _lrPdfCaddieSessionHtml(_sid) : '';
  var _sgHtml = _lrPdfSGHtml(mePlayer, holes);
  if (_cHtml || _sgHtml) {
    advancedPrefix = _cHtml
      + (_cHtml && _sgHtml ? '<div class="page-break"></div>' : '')
      + _sgHtml
      + '<div class="page-break"></div>';
  }
}

const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Gordy \u2014 ${escHtml(lrState.courseName)}</title>
${_pdfFontsLink}
${_pdfSharedCSS()}
</head><body>
<button class="print-btn no-print" onclick="window.print()">\uD83D\uDDA8 Print / Save PDF</button>
${_pdfBanner(meName, meHcp, logo)}
<div class="hero">
<div><div class="hero-title">\u26F3 ${escHtml(lrState.courseName)}</div>
<div class="hero-meta">${escHtml(mode)} \u00B7 ${lrState.date} \u00B7 ${escHtml(lrState.conditions)} \u00B7 ${holes.length} holes</div></div>
<div style="text-align:right;font-size:.62rem;color:#8a9e82">${lrState.tee?lrState.tee+' tees':''}</div>
</div>

${advancedPrefix}${buildTable(false,'Scorecard \u2014 Gross')}

${hasHcp?`<div class="page-break"></div>${buildTable(true,'Scorecard \u2014 Net')}`:''}

<div class="page-break"></div>
<div class="card"><h3>Leaderboard</h3>
<table><thead><tr><th>#</th><th>Player</th><th style="text-align:center">Gross</th><th style="text-align:center">vs Par</th><th style="text-align:center">HCP</th></tr></thead>
<tbody>${leaderboard}</tbody></table></div>

<div class="footer">Gordy the Virtual Caddy \u00B7 Round generated ${new Date().toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'})}</div>
<script>window.onload=()=>window.print();<\/script>
</body></html>`;

const w = window.open('','_blank');
if(w){ w.document.open(); w.document.write(html); w.document.close(); }
}

// \u2500\u2500 Discard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// lrDiscardRound -- called from summary screen button.
// Uses inline confirm strip (not banner) matching range discard pattern.
// Hole screen discard is accessible via lrEndBanner Discard button (index.html).
function lrDiscardRound() {
if(document.getElementById('lrDiscardConfirm')) return;
var btn = document.querySelector('[onclick="lrDiscardRound()"]');
if(!btn) return;
var wrap = document.createElement('div');
wrap.id = 'lrDiscardConfirm';
wrap.style.cssText = 'margin-top:8px;font-size:.68rem;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
wrap.innerHTML = '<span style="color:var(--danger)">Discard this round? All scores will be lost.</span>' +
  '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);font-size:.62rem;padding:2px 8px" onclick="lrConfirmDiscard()">' +
  'Discard</button>' +
  '<button class="btn sec" style="font-size:.62rem;padding:2px 8px" onclick="document.getElementById(\'lrDiscardConfirm\').remove()">Cancel</button>';
btn.parentNode.insertBefore(wrap, btn.nextSibling);
}
function lrConfirmDiscard() {
const banner = document.getElementById('lrEndBanner');
if(banner) banner.style.display='none';
// Old banner button reset removed -- no longer rewiring confirm button:
// const confirmBtn = banner?.querySelector('.btn.danger');
// if(confirmBtn) { confirmBtn.textContent = 'End Round'; confirmBtn.onclick = lrConfirmEnd; }
_lrMapUnmount(); _lrMapClearStorage();  /* G2 */
lrState = null;
if (window.clearActiveSession) window.clearActiveSession('round');
document.getElementById('lrOverlay').classList.remove('active');
lrUpdatePill();
}

// \u2500\u2500 Screen switcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrShowScreen(id) {
['lrSetup','lrHoleScreen','lrTallyScreen','lrSummaryScreen'].forEach(s=>{
  const el=document.getElementById(s);
  if(el) el.style.display = s===id ? 'flex' : 'none';
});
// Always hide end banner on screen change
const b=document.getElementById('lrEndBanner');
if(b) b.style.display='none';
}

function lrCloseRound() {
document.getElementById('lrOverlay').classList.remove('active');
_lrMapUnmount(); _lrMapClearStorage();  /* G2 */
lrState = null;
lrUpdatePill();
if(window.showTab) window.showTab('rounds');
}

// -- Phase 4: Advanced shot logging -- module-level state --
var _lrAdvancedOpen    = false;
var _lrShotDraft       = null;
var _lrEditingIndex    = null;
var _lrObConfirmPending  = false;
var _lrDeleteConfirmIdx  = null;
var _lrGirPromptPending  = false;

// -- Persist active round to localStorage on every meaningful state change --
function _lrPersist() {
  if (window.lrState) localStorage.setItem('gordy:activeRound', JSON.stringify(window.lrState));
  if (window.updateSessionPill) window.updateSessionPill();
}

// \u2500\u2500 Phase 4b: Strokes Gained \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _lrCalcSG(shots) {
  if (!shots || !shots.length) return [];
  return shots.map(function(shot, i) {
    var expBefore = sgExpected(shot.lie, shot.distanceToHole);
    if (expBefore === null) return null;
    var expAfter;
    if (i === shots.length - 1) {
      expAfter = 0; /* holed out */
    } else {
      var next = shots[i + 1];
      expAfter = sgExpected(next.lie, next.distanceToHole);
      if (expAfter === null) return null;
    }
    return parseFloat((expBefore - expAfter - 1).toFixed(3));
  });
}

function _lrFmtSG(val) {
  if (val === null || val === undefined) return null;
  var sign = val >= 0 ? '+' : '\u2212';
  return sign + Math.abs(val).toFixed(3);
}

function _lrSGColor(val) {
  if (val === null || val === undefined) return 'var(--tx3)';
  if (val > 0) return 'var(--ac2)';
  if (val < 0) return 'var(--danger)';
  return 'var(--tx3)';
}

function _lrWriteSG(s) {
  /* Write shot.sg onto each shot in s.shots[], derived from _lrCalcSG */
  if (!s.shots || !s.shots.length) return;
  var sgVals = _lrCalcSG(s.shots);
  s.shots.forEach(function(shot, i) {
    shot.sg = (sgVals[i] !== null && sgVals[i] !== undefined)
      ? sgVals[i] : null;
  });
}

// \u2500\u2500 SG Categorisation Engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _lrSGCategory(shot, shotIndex, holePar) {
  /* OTT: first shot on par 4 or 5 */
  if (shotIndex === 0 && holePar >= 4) return 'OTT';
  /* PUTT: any shot from green */
  if (shot.lie === 'green') return 'PUTT';
  /* APP: first shot on par 3 */
  if (shotIndex === 0 && holePar === 3) return 'APP';
  /* Need distanceToHole to distinguish ARG vs APP */
  if (shot.distanceToHole === null || shot.distanceToHole === undefined) return null;
  /* ARG: within 30 yards, not green */
  if (shot.distanceToHole <= 30) return 'ARG';
  /* APP: beyond 30 yards, not green */
  return 'APP';
}

function _lrAggregateSG(shots, holePar) {
  var result = { OTT: 0, APP: 0, ARG: 0, PUTT: 0, total: 0 };
  if (!shots || !shots.length) return result;
  shots.forEach(function(shot, i) {
    if (shot.sg === null || shot.sg === undefined) return;
    var cat = _lrSGCategory(shot, i, holePar);
    if (!cat) return;
    result[cat] = +(result[cat] + shot.sg).toFixed(3);
    result.total = +(result.total + shot.sg).toFixed(3);
  });
  return result;
}

function _lrRoundSG(scores, holes) {
  var result = { OTT: 0, APP: 0, ARG: 0, PUTT: 0, total: 0 };
  scores.forEach(function(s, i) {
    if (!s.shots || !s.shots.length) return;
    var hole = holes[i];
    if (!hole) return;
    var h = _lrAggregateSG(s.shots, hole.par);
    result.OTT   = +(result.OTT  + h.OTT).toFixed(3);
    result.APP   = +(result.APP  + h.APP).toFixed(3);
    result.ARG   = +(result.ARG  + h.ARG).toFixed(3);
    result.PUTT  = +(result.PUTT + h.PUTT).toFixed(3);
    result.total = +(result.total + h.total).toFixed(3);
  });
  return result;
}

function _lrRoundFIR(scores, holes) {
  var eligible = 0, hit = 0;
  scores.forEach(function(s, i) {
    var hole = holes[i];
    if (!hole || hole.par < 4 || !s.shots || !s.shots.length) return;
    eligible++;
    if (s.fir === true) hit++;
  });
  return { hit: hit, eligible: eligible, pct: eligible > 0 ? hit / eligible : null };
}

// \u2500\u2500 Phase 4: Advanced Shot Logging \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _lrDefaultDraft(holeIdx) {
  var hole     = lrState.holes[holeIdx];
  var pi       = lrState.curPlayer;
  var s        = lrState.players[pi].scores[holeIdx];
  var isFirst  = !s.shots || s.shots.length === 0;
  var lastShot = s.shots && s.shots.length ? s.shots[s.shots.length - 1] : null;
  var dist     = isFirst ? (hole.yards || null) : null;
  var autoMode = isFirst ? 'standard'
    : lastShot && lastShot.shot_mode === 'approach' && lastShot.radial_ring && lastShot.lie === 'green' ? 'on_green' /* LR-TAB1 */
    : dist !== null && dist <= 100 ? 'approach'
    : 'standard';
  return {
    clubId:          '',
    shot_mode:       autoMode,
    lie:             isFirst ? 'tee' : '',
    radial_ring:     null,
    radial_segment:  null,
    flight_path:     null,
    distanceToHole:  dist,
    is_ob:           false,
    penalty_strokes: 0,
    timestamp:       '',
    entryType:       'live'
  };
}

function _lrCalcScore(shots) {
  return shots.reduce(function(t, sh) { return t + 1 + (sh.penalty_strokes || 0); }, 0);
}

function _lrAutoFir(shots) {
  if (!shots || !shots.length) return null;
  return shots[0].lie === 'fairway';
}

/* Radial arc helpers -- identical convention to range.js _pt / _arcPath (Phase 4 handoff note: duplicated from range.js) */
function _lrPt(cx, cy, r, angleDeg) {
  var rad = angleDeg * Math.PI / 180;
  return { x: +(cx + r * Math.sin(rad)).toFixed(3), y: +(cy - r * Math.cos(rad)).toFixed(3) };
}

function _lrArcPath(cx, cy, r1, r2, startDeg, endDeg) {
  var s1 = _lrPt(cx, cy, r2, startDeg), e1 = _lrPt(cx, cy, r2, endDeg);
  var s2 = _lrPt(cx, cy, r1, endDeg),   e2 = _lrPt(cx, cy, r1, startDeg);
  return 'M ' + s1.x + ' ' + s1.y + ' A ' + r2 + ' ' + r2 + ' 0 0 1 ' + e1.x + ' ' + e1.y
    + ' L ' + s2.x + ' ' + s2.y + ' A ' + r1 + ' ' + r1 + ' 0 0 0 ' + e2.x + ' ' + e2.y + ' Z';
}

/* Radial SVG builder -- matches range.js _buildRadialSVG (interactive mode only, onclick wired to lrSelectZone)
   isApproach=true: inner+bull get muted green base fill to indicate proximity to hole; flag icon on bull */
function _buildLrRadialSVG(selRing, selSeg, isApproach) {
  var cx = 150, cy = 150;
  var rB = ZONE_RING_RADII.bull, rI = ZONE_RING_RADII.inner, rO = ZONE_RING_RADII.outer;
  var bg = '<rect width="300" height="300" fill="#6a9a50"/>'
    + '<rect x="90" y="0" width="120" height="300" fill="#9ec880"/>';
  var paths = '';
  /* 8 inner segments */
  for (var i = 0; i < 8; i++) {
    var isSel    = selRing === 'inner' && selSeg === i;
    var baseFill = isApproach ? 'rgba(80,160,80,0.5)' : 'rgba(255,255,255,0.18)';
    var fill     = isSel ? 'rgba(180,30,30,0.45)' : baseFill;
    var strk     = isSel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
    var sw       = isSel ? '2.5' : '1.5';
    var d        = _lrArcPath(cx, cy, rB, rI, (i * 45) - 22.5, (i * 45) + 22.5);
    paths += '<path d="' + d + '" fill="' + fill + '" stroke="' + strk + '" stroke-width="' + sw
      + '" onclick="lrSelectZone(\'inner\',' + i + ')" style="cursor:pointer;touch-action:manipulation"></path>';
  }
  /* 8 outer segments -- neutral regardless of mode */
  for (var j = 0; j < 8; j++) {
    var isSel2 = selRing === 'outer' && selSeg === j;
    var fill2  = isSel2 ? 'rgba(180,30,30,0.25)' : 'rgba(255,255,255,0.18)';
    var strk2  = isSel2 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
    var sw2    = isSel2 ? '2.5' : '1.5';
    var d2     = _lrArcPath(cx, cy, rI, rO, (j * 45) - 22.5, (j * 45) + 22.5);
    paths += '<path d="' + d2 + '" fill="' + fill2 + '" stroke="' + strk2 + '" stroke-width="' + sw2
      + '" onclick="lrSelectZone(\'outer\',' + j + ')" style="cursor:pointer;touch-action:manipulation"></path>';
  }
  /* Bullseye */
  var bullSel      = selRing === 'bull';
  var bullBaseFill = isApproach ? 'rgba(80,160,80,0.5)' : 'rgba(255,255,255,0.18)';
  var bullFill     = bullSel ? 'rgba(180,30,30,0.85)' : bullBaseFill;
  var bullStrk     = bullSel ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.40)';
  var bullSW       = bullSel ? '2.5' : '1.5';
  paths += '<circle cx="150" cy="150" r="' + rB + '" fill="' + bullFill + '" stroke="' + bullStrk
    + '" stroke-width="' + bullSW + '" onclick="lrSelectZone(\'bull\',null)" style="cursor:pointer;touch-action:manipulation"></circle>';
  /* Flag icon on bull for approach mode */
  if (isApproach) {
    paths += '<line x1="150" y1="132" x2="150" y2="168" stroke="rgba(255,255,255,0.85)" stroke-width="2" pointer-events="none"/>'
      + '<polygon points="150,132 164,139 150,146" fill="rgba(255,255,255,0.85)" pointer-events="none"/>';
  }
  return '<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"'
    + ' style="width:100%;max-width:300px;display:block;margin:0 auto">'
    + bg + paths + '</svg>';
}

function _lrZoneLabel(ring, seg) {
  if (!ring) return '\u2014';
  if (ring === 'bull') return 'Bull';
  return (ring === 'inner' ? 'Inner' : 'Outer')
    + (seg !== null && seg !== undefined ? ' \u00B7 ' + (ZONE_SEGMENT_LABELS[seg] || seg) : '');
}

function _lrModeBtn(mode, active) {
  var labels = { standard: 'Standard', approach: 'Approach', on_green: 'On Green' };
  return '<button class="implied-tog' + (active === mode ? ' on' : '')
    + '" style="flex:1" onclick="lrSetShotMode(\'' + mode + '\')">' + labels[mode] + '</button>';
}

function _lrClubOptions(selectedId) {
  var opts = '<option value="">-- Club --</option>';
  if (typeof bag !== 'undefined' && bag && bag.length) {
    bag.forEach(function(c) {
      var label = c.identifier || c.type;
      opts += '<option value="' + escHtml(c.id) + '"' + (c.id === selectedId ? ' selected' : '') + '>'
        + escHtml(label) + '</option>';
    });
  }
  return opts;
}

function _lrShotLogHtml(shots) {
  if (!shots || !shots.length) return '';
  var rows = shots.map(function(sh, i) {
    var zone   = sh.radial_ring ? _lrZoneLabel(sh.radial_ring, sh.radial_segment) : '';
    var obTag  = sh.is_ob
      ? ' <span style="color:var(--danger);font-size:.6rem">Penalty+' + (sh.penalty_strokes || 0) + '</span>'
      : '';
    var sgTag = (sh.sg !== null && sh.sg !== undefined)
      ? ' <span style="color:' + _lrSGColor(sh.sg) + ';font-size:.6rem">\u00B7 SG: ' + _lrFmtSG(sh.sg) + '</span>'
      : '';
    var editBtn = '<button class="btn sec" style="font-size:.55rem;padding:1px 5px;margin-left:4px"'
      + ' onclick="lrEditShot(' + i + ')">Edit</button>';
    var delBtn  = '<button class="btn sec" style="font-size:.55rem;padding:1px 5px;margin-left:2px;color:var(--danger)"'
      + ' onclick="lrDeleteShot(' + i + ')">\u2715</button>';
    var confirmHtml = (_lrDeleteConfirmIdx === i)
      ? '<div style="margin-top:4px;font-size:.6rem;display:flex;gap:6px;align-items:center">'
          + '<span style="color:var(--danger)">Delete this shot?</span>'
          + '<button class="btn" style="background:var(--danger);color:#fff;border-color:var(--danger);'
          + 'font-size:.55rem;padding:1px 6px" onclick="lrDeleteShotConfirm(' + i + ')">Yes</button>'
          + '<button class="btn sec" style="font-size:.55rem;padding:1px 6px" onclick="lrDeleteShotCancel()">No</button>'
          + '</div>'
      : '';
    var clubDisplay = (function() {
      var c = bag && bag.find(function(x) { return x.id === sh.clubId; });
      return c ? [c.type, c.identifier].filter(Boolean).join(' ') : '\u2014';
    })();
    var parts = ['Shot ' + (i + 1), clubDisplay, sh.shot_mode, sh.lie || '\u2014'];
    if (zone) parts.push(zone);
    if (sh.flight_path) parts.push(sh.flight_path);
    return '<div style="font-size:.65rem;font-family:\'DM Mono\',monospace;padding:5px 0;border-bottom:1px solid var(--br)">'
      + '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">'
      + '<span>' + parts.join(' \u00B7 ') + obTag + sgTag + '</span>' + editBtn + delBtn
      + '</div>' + confirmHtml + '</div>';
  }).join('');
  return '<div style="margin-bottom:10px">'
    + '<div style="font-size:.54rem;text-transform:uppercase;letter-spacing:.08em;color:var(--tx3);margin-bottom:4px">Shot Log</div>'
    + rows + '</div>';
}

function _lrGirFirToggles(s, hole) {
  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">';
  html += '<div class="card" style="margin-bottom:0"><div class="card-title">GIR</div>'
    + '<div style="display:flex;gap:6px;margin-top:4px">'
    + '<button class="lr-tog' + (s.gir === true  ? ' on-y' : '') + '" style="flex:1" onclick="lrToggleGir(true)">\u2713</button>'
    + '<button class="lr-tog' + (s.gir === false ? ' on-n' : '') + '" style="flex:1" onclick="lrToggleGir(false)">\u2717</button>'
    + '</div></div>';
  if (hole.par > 3) {
    html += '<div class="card" style="margin-bottom:0"><div class="card-title">FIR</div>'
      + '<div style="display:flex;gap:6px;margin-top:4px">'
      + '<button class="lr-tog' + (s.fir === true  ? ' on-y' : '') + '" style="flex:1" onclick="lrToggleFir(true)">\u2713</button>'
      + '<button class="lr-tog' + (s.fir === false ? ' on-n' : '') + '" style="flex:1" onclick="lrToggleFir(false)">\u2717</button>'
      + '</div></div>';
  }
  return html + '</div>';
}

function _lrAdvancedHtml(holeIdx, pi, shared) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(holeIdx);
  var d    = _lrShotDraft;
  var s    = lrState.players[pi].scores[holeIdx];
  var shots = s.shots || [];
  var hole  = lrState.holes[holeIdx];
  var arrow = _lrAdvancedOpen ? '\u25B2' : '\u25BC';
  var hdr   = '<div class="collapsible-hdr" onclick="lrToggleAdvanced()" id="lrAdvancedHdr"'
    + ' style="cursor:pointer;padding:10px 0;font-size:.72rem;font-family:\'DM Mono\',monospace;'
    + 'color:var(--tx3);display:flex;justify-content:space-between;border-top:1px solid var(--br);margin-top:10px">'
    + '<span>Advanced Mode</span><span>' + arrow + '</span></div>';
  if (!_lrAdvancedOpen) return hdr + '<div id="lrAdvancedBody" style="display:none"></div>';

  var html = '<div id="lrAdvancedBody" style="padding-bottom:12px">';
  html += _lrShotLogHtml(shots);

  /* GIR prompt when Hole Complete pressed without on_green mode */
  if (_lrGirPromptPending) {
    html += '<div class="card" style="margin-bottom:8px">'
      + '<div style="font-size:.68rem;margin-bottom:10px">Did you reach the green?</div>'
      + '<div style="display:flex;gap:8px">'
      + '<button class="lr-tog" style="flex:1" onclick="lrGirPromptAnswer(true)">\u2713 Yes</button>'
      + '<button class="lr-tog" style="flex:1" onclick="lrGirPromptAnswer(false)">\u2717 No</button>'
      + '<button class="btn sec" style="flex:1;font-size:.65rem" onclick="lrGirPromptAnswer(null)">Skip</button>'
      + '</div></div></div>';
    return hdr + html;
  }

  if (d.shot_mode === 'on_green') {
    /* On Green body */
    var ogDist = (s.on_green_distance !== undefined && s.on_green_distance !== null) ? s.on_green_distance : '';
    var cpc    = s.chip_putt_count || 0;
    var holed  = s.holed_out || false;
    html += '<div class="card" style="margin-bottom:8px">'
      + '<div style="font-size:.54rem;text-transform:uppercase;letter-spacing:.08em;color:var(--tx3);margin-bottom:8px">On Green</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:10px">'
      + _lrModeBtn('standard', d.shot_mode) + _lrModeBtn('approach', d.shot_mode) + _lrModeBtn('on_green', d.shot_mode)
      + '</div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Distance to Hole (ft)</div>'
      + '<input type="number" inputmode="numeric" class="field"'
      + ' style="width:100%;background:var(--bg);border:1px solid var(--br);border-radius:4px;'
      + 'color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.72rem;padding:5px 8px;outline:none"'
      + ' value="' + ogDist + '" oninput="lrSetOnGreenDist(this.value)"></div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Strokes on Green</div>'
      + '<div class="lr-stepper">'
      + '<button class="lr-step-btn sm" onclick="lrAdjChipPutt(-1)">\u2212</button>'
      + '<div class="lr-step-val"><div class="lr-step-num sm">' + cpc + '</div></div>'
      + '<button class="lr-step-btn sm" onclick="lrAdjChipPutt(1)">+</button>'
      + '</div></div>'
      + '<div style="margin-bottom:10px"><div class="card-title">Holed Out</div>'
      + '<div style="display:flex;gap:6px;margin-top:4px">'
      + '<button class="lr-tog' + (holed ? ' on-y' : '') + '" style="flex:1" onclick="lrToggleHoledOut()">'
      + (holed ? '\u2713 Yes' : 'No') + '</button>'
      + '</div></div>'
      + _lrGirFirToggles(s, hole)
      + '<button class="rbtn" style="width:100%;margin-top:10px" onclick="lrCompleteHole()">\u2713 Complete Hole</button>'
      + '</div>';
  } else {
    /* Standard / Approach entry form */
    var shotNum   = _lrEditingIndex !== null ? (_lrEditingIndex + 1) : (shots.length + 1);
    var shotLabel = _lrEditingIndex !== null ? 'Editing Shot ' + shotNum : 'Shot ' + shotNum;
    var lies = d.shot_mode === 'approach'
      ? ['green','fairway','rough','sand','recovery']
      : ['fairway','rough','sand','recovery'];
    html += '<div class="card" style="margin-bottom:8px">'
      + '<div style="font-size:.54rem;text-transform:uppercase;letter-spacing:.08em;color:var(--tx3);margin-bottom:8px">'
      + '<span style="font-size:1.1rem;font-weight:700;color:var(--tx);letter-spacing:0;text-transform:none;margin-right:6px">' + shotLabel + '</span>'
      + (function() {
          /* SG info line: show expected strokes from current lie + distance */
          if (!d.lie || d.distanceToHole === null || d.distanceToHole === undefined) return '';
          var exp = sgExpected(d.lie, d.distanceToHole);
          if (exp === null) return '';
          return '<span style="font-size:.62rem;color:var(--tx3)">Exp: ' + exp.toFixed(2) + ' strokes from here</span>';
        })()
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:10px">'
      + _lrModeBtn('standard', d.shot_mode) + _lrModeBtn('approach', d.shot_mode) + _lrModeBtn('on_green', d.shot_mode)
      + '</div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Distance to Hole (yds)</div>'
      + '<input type="number" inputmode="numeric" class="field"'
      + ' style="width:100%;background:var(--bg);border:1px solid var(--br);border-radius:4px;'
      + 'color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.72rem;padding:5px 8px;outline:none"'
      + ' value="' + (d.distanceToHole !== null ? d.distanceToHole : '') + '" onblur="lrSetDist(this.value)"></div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Club</div>'
      + '<select class="field" style="width:100%;background:var(--bg);border:1px solid var(--br);border-radius:4px;'
      + 'color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.72rem;padding:5px 8px;outline:none"'
      + ' onchange="lrSetClub(this.value)">' + _lrClubOptions(d.clubId) + '</select></div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Result Zone</div>'
      + '<div style="display:flex;justify-content:center">' + _buildLrRadialSVG(d.radial_ring, d.radial_segment, d.shot_mode === 'approach') + '</div>'
      + '<div style="text-align:center;font-size:.62rem;color:var(--tx3);margin-top:4px">'
      + _lrZoneLabel(d.radial_ring, d.radial_segment) + '</div></div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Lie</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px">';
    lies.forEach(function(lie) {
      html += '<button class="implied-tog' + (d.lie === lie ? ' on' : '') + '" onclick="lrSetShotLie(\''
        + lie + '\')">' + lie.charAt(0).toUpperCase() + lie.slice(1) + '</button>';
    });
    html += '</div></div>'
      + '<div style="margin-bottom:8px"><div class="card-title">Flight Path</div>'
      + '<div style="display:flex;gap:6px;margin-top:4px">';
    [['straight','Straight'],['left-to-right','L\u2192R'],['right-to-left','R\u2192L']].forEach(function(fp) {
      html += '<button class="implied-tog' + (d.flight_path === fp[0] ? ' on' : '') + '" style="flex:1"'
        + ' onclick="lrSetFlightPath(\'' + fp[0] + '\')">' + fp[1] + '</button>';
    });
    html += '</div></div>';
    /* OB toggle / inline confirm */
    if (_lrObConfirmPending) {
      html += '<div style="margin-bottom:10px;padding:8px;background:var(--gr2);border-radius:6px;font-size:.68rem">'
        + 'Penalty \u2014 add 1 penalty stroke?'
        + '<button class="btn" style="font-size:.62rem;padding:2px 8px;margin-left:8px;'
        + 'background:var(--danger);color:#fff;border-color:var(--danger)" onclick="lrObConfirm(true)">Yes</button>'
        + '<button class="btn sec" style="font-size:.62rem;padding:2px 8px;margin-left:4px" onclick="lrObConfirm(false)">No</button>'
        + '</div>';
    } else {
      html += '<div style="margin-bottom:10px">'
        + '<button class="implied-tog' + (d.is_ob ? ' on' : '') + '" onclick="lrToggleOb()">Penalty: '
        + (d.is_ob ? 'Yes' : 'No') + '</button></div>';
    }
    html += '<button class="rbtn" style="width:100%" onclick="lrRecordShot()">'
      + (_lrEditingIndex !== null ? 'Update Shot' : 'Record Shot') + '</button></div>';
    /* GIR / FIR and Hole Complete once at least one shot is logged */
    if (shots.length > 0) {
      html += _lrGirFirToggles(s, hole);
      html += '<button class="btn sec" style="width:100%;margin-top:8px" onclick="lrCompleteHole()">\u2713 Hole Complete</button>';
    }
  }
  return hdr + html + '</div>';
}

/* ── Exported advanced-mode interaction functions ────────────────────────── */

function lrToggleAdvanced() {
  _lrAdvancedOpen = !_lrAdvancedOpen;
  if (_lrAdvancedOpen && !_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  lrRenderHole();
}

function lrSetShotMode(mode) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.shot_mode = mode;
  if (mode === 'on_green') {
    _lrShotDraft.radial_ring    = null;
    _lrShotDraft.radial_segment = null;
    _lrShotDraft.flight_path    = null;
  }
  _lrObConfirmPending = false;
  lrRenderHole();
}

function lrSetShotLie(lie) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.lie = lie;
  lrRenderHole();
}

function lrSetFlightPath(fp) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.flight_path = _lrShotDraft.flight_path === fp ? null : fp;
  lrRenderHole();
}

function lrSelectZone(ring, seg) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  if (_lrShotDraft.radial_ring === ring && _lrShotDraft.radial_segment === seg) {
    _lrShotDraft.radial_ring    = null;
    _lrShotDraft.radial_segment = null;
  } else {
    _lrShotDraft.radial_ring    = ring;
    _lrShotDraft.radial_segment = seg;
  }
  lrRenderHole();
}

function lrSetClub(clubId) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.clubId = clubId;
}

function lrSetDist(val) {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.distanceToHole = val !== '' ? parseFloat(val) : null;
}

function lrToggleOb() {
  if (!_lrShotDraft) _lrShotDraft = _lrDefaultDraft(lrState.curHole);
  _lrShotDraft.is_ob = !_lrShotDraft.is_ob;
  _lrObConfirmPending = _lrShotDraft.is_ob;
  if (!_lrShotDraft.is_ob) _lrShotDraft.penalty_strokes = 0;
  lrRenderHole();
}

function lrObConfirm(addPenalty) {
  if (!_lrShotDraft) return;
  _lrShotDraft.penalty_strokes = addPenalty ? 1 : 0;
  _lrObConfirmPending = false;
  lrRenderHole();
}

function lrRecordShot() {
  if (!lrState || !_lrShotDraft) return;
  if (_lrObConfirmPending) return; /* must confirm OB first */
  var d       = _lrShotDraft;
  d.timestamp = localISO(); /* CLEAN11 */
  var pi      = lrState.curPlayer;
  var holeIdx = lrState.curHole;
  var s       = lrState.players[pi].scores[holeIdx];
  if (!s.shots) s.shots = [];
  var wasOb  = d.is_ob;
  var isEdit = _lrEditingIndex !== null;
  /* Phase 4b: stamp clubName at record time for stable cross-session identification */
  d.clubName = (function() {
    var c = bag && bag.find(function(x) { return x.id === d.clubId; });
    return c ? (c.identifier || c.type) : (d.clubId || '');
  })();
  /* SLUG1 -- stamp slug at record time; read-side flip deferred to Pass 2 */
  d.clubSlug = (function() {
    var c = bag && bag.find(function(x) { return x.id === d.clubId; });
    return c ? (c.slug || clubSlug(c)) : '';
  })();
  if (isEdit) {
    s.shots[_lrEditingIndex] = Object.assign({}, d);
  } else {
    s.shots.push(Object.assign({}, d));
  }
  /* Auto-FIR: first shot, par 4/5 only */
  var hole = lrState.holes[holeIdx];
  if (s.shots.length === 1 && hole.par > 3) s.fir = _lrAutoFir(s.shots);
  /* Derive score from shots */
  s.score = _lrCalcScore(s.shots);
  /* Phase 4b: calculate SG immediately so shot log shows values */
  _lrWriteSG(s);
  _lrEditingIndex     = null;
  _lrObConfirmPending = false;
  _lrDeleteConfirmIdx = null;
  /* Post-OB: pre-fill recovery draft */
  _lrShotDraft = _lrDefaultDraft(holeIdx);
  if (wasOb && !isEdit) _lrShotDraft.lie = 'recovery';
  lrRenderHole();
  _lrPersist();
}

function lrEditShot(idx) {
  var pi = lrState.curPlayer;
  var s  = lrState.players[pi].scores[lrState.curHole];
  if (!s.shots || !s.shots[idx]) return;
  _lrShotDraft        = Object.assign({}, s.shots[idx]);
  _lrEditingIndex     = idx;
  _lrObConfirmPending = false;
  _lrDeleteConfirmIdx = null;
  _lrGirPromptPending = false;
  lrRenderHole();
}

function lrDeleteShot(idx) {
  _lrDeleteConfirmIdx = idx;
  lrRenderHole();
}

function lrDeleteShotConfirm(idx) {
  var pi   = lrState.curPlayer;
  var s    = lrState.players[pi].scores[lrState.curHole];
  var hole = lrState.holes[lrState.curHole];
  if (!s.shots) return;
  s.shots.splice(idx, 1);
  s.score = s.shots.length ? _lrCalcScore(s.shots) : null;
  if (hole.par > 3) s.fir = s.shots.length ? _lrAutoFir(s.shots) : null;
  _lrDeleteConfirmIdx = null;
  if (_lrEditingIndex === idx) { _lrEditingIndex = null; _lrShotDraft = _lrDefaultDraft(lrState.curHole); }
  lrRenderHole();
  _lrPersist();
}

function lrDeleteShotCancel() {
  _lrDeleteConfirmIdx = null;
  lrRenderHole();
}

function lrCompleteHole() {
  var pi      = lrState.curPlayer;
  var holeIdx = lrState.curHole;
  var s       = lrState.players[pi].scores[holeIdx];
  var hole    = lrState.holes[holeIdx];
  var shots   = s.shots || [];
  var isOnGreen = _lrShotDraft && _lrShotDraft.shot_mode === 'on_green';
  if (isOnGreen) {
    var cpc      = s.chip_putt_count || 0;
    s.putts      = cpc; /* backwards compat */
    var preGreen = shots.filter(function(sh) { return sh.shot_mode !== 'on_green'; });
    s.score      = _lrCalcScore(preGreen) + cpc;
    if (s.gir === null || s.gir === undefined) {
      var girStrokes = preGreen.reduce(function(t, sh) { return t + 1 + (sh.penalty_strokes || 0); }, 0);
      s.gir = girStrokes <= (hole.par - 2);
    }
    _lrWriteSG(s);
    _lrShotDraft = null; _lrEditingIndex = null;
    _lrObConfirmPending = false; _lrDeleteConfirmIdx = null; _lrGirPromptPending = false;
    lrGoHole(1);
  } else {
    /* No on_green -- prompt for GIR if not already set */
    if (!_lrGirPromptPending && (s.gir === null || s.gir === undefined)) {
      _lrGirPromptPending = true;
      lrRenderHole();
      return;
    }
    _lrShotDraft = null; _lrEditingIndex = null;
    _lrObConfirmPending = false; _lrDeleteConfirmIdx = null; _lrGirPromptPending = false;
    lrGoHole(1);
  }
}

function lrGirPromptAnswer(val) {
  var pi = lrState.curPlayer;
  var s  = lrState.players[pi].scores[lrState.curHole];
  if (val !== null) s.gir = val;
  _lrShotDraft = null; _lrEditingIndex = null;
  _lrObConfirmPending = false; _lrDeleteConfirmIdx = null; _lrGirPromptPending = false;
  lrGoHole(1);
}

function lrToggleGir(val) {
  if (!lrState) return;
  var shared = !!(LR_MODES[lrState.mode] && LR_MODES[lrState.mode].shared);
  lrSetGir(lrState.curPlayer, lrState.curHole, val, shared);
}

function lrToggleFir(val) {
  if (!lrState) return;
  var s = lrState.players[lrState.curPlayer].scores[lrState.curHole];
  s.fir = s.fir === val ? null : val;
  lrRenderHole();
  _lrPersist();
}

function lrSetOnGreenDist(val) {
  if (!lrState) return;
  lrState.players[lrState.curPlayer].scores[lrState.curHole].on_green_distance =
    val !== '' ? parseFloat(val) : null;
  _lrPersist();
}

function lrAdjChipPutt(delta) {
  if (!lrState) return;
  var s = lrState.players[lrState.curPlayer].scores[lrState.curHole];
  s.chip_putt_count = Math.max(0, (s.chip_putt_count || 0) + delta);
  lrRenderHole();
  _lrPersist();
}

function lrToggleHoledOut() {
  if (!lrState) return;
  var s = lrState.players[lrState.curPlayer].scores[lrState.curHole];
  s.holed_out = !s.holed_out;
  lrRenderHole();
  _lrPersist();
}

// \u2500\u2500 Caddie Session Linking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/* Memoised parse cache -- invalidated when linkedSessionId changes */
var _lrSessionCache = { id: null, data: null };

function _lrParseSession(id) {
  if (_lrSessionCache.id === id && _lrSessionCache.data) return _lrSessionCache.data;
  var h = (history || []).find(function(x) { return x.id === id; });
  if (!h || !h.text) { _lrSessionCache = { id: id, data: null }; return null; }
  var lines = h.text.split('\n');
  var bagLines = [], holeLines = [];
  lines.forEach(function(raw) {
    var l = raw.trim();
    if (!l || l.startsWith('OPTIMISED BAG') || l.startsWith('Total:')) return;
    if (l === 'COURSE STRATEGY' || l === 'HOLE-BY-HOLE') return;
    if (/^H\d+\s*\|/.test(l)) { holeLines.push(l); return; }
    if (/^\d+\.\s+/.test(l)) { bagLines.push(l); return; }
  });
  /* Parse hole lines into map keyed by hole number */
  var holeMap = {};
  holeLines.forEach(function(l) {
    var p = l.split('|').map(function(s) { return s.trim(); });
    var num = parseInt((p[0] || '').replace(/^H/, ''));
    if (!num) return;
    holeMap[num] = {
      num:    num,
      par:    (p[1] || '').replace('Par ', '').trim(),
      yds:    (p[2] || '').replace(' yds', '').trim(),
      strokes:(p[4] || '').trim(),
      advice: p.slice(5).filter(Boolean).join(' \u00B7 ')
    };
  });
  var data = { bagLines: bagLines, holeMap: holeMap, sessionTee: h.tee || '' };
  _lrSessionCache = { id: id, data: data };
  return data;
}

/* Returns array of candidate sessions matching courseName, newest first */
function _lrMatchingSessions(courseName) {
  if (!history || !history.length) return [];
  var cn = (courseName || '').toLowerCase().trim();
  if (!cn) return [];
  return history.filter(function(h) {
    if (h.type !== 'optimisation' && h.type !== 'caddie' && h.type !== 'both') return false;
    var hc = (h.course || '').toLowerCase().trim();
    /* fuzzy: at least one word of course name matches */
    return cn.split(' ').some(function(w) { return w.length > 2 && hc.includes(w); })
        || hc.split(' ').some(function(w) { return w.length > 2 && cn.includes(w); });
  }).sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
}

/* Render the session picker dropdown for setup screen */
function lrRenderSessionPicker() {
  var row = document.getElementById('lrSessionLinkRow');
  if (!row) return;
  var courseId = document.getElementById('lrCourseSelect') && document.getElementById('lrCourseSelect').value;
  var course = courseId ? (courses || []).find(function(c) { return c.id === courseId; }) : null;
  if (!course) { row.style.display = 'none'; return; }
  var matches = _lrMatchingSessions(course.name);
  if (!matches.length) { row.style.display = 'none'; return; }
  var teeVal = document.getElementById('lrTeeSelect') ? document.getElementById('lrTeeSelect').value : '';
  var tee = course.tees && teeVal ? course.tees.find(function(t) { return t.id === teeVal; }) : null;
  var teeName = tee ? tee.name : '';
  var sel = document.getElementById('lrLinkedSession');
  if (!sel) return;
  sel.innerHTML = '<option value="">\u2014 None \u2014</option>'
    + matches.map(function(h) {
        var warn = teeName && h.tee && h.tee !== teeName ? ' (\u26A0 ' + escHtml(h.tee) + ' tee)' : '';
        return '<option value="' + escHtml(h.id) + '">' + escHtml(h.date) + ' \u00B7 ' + escHtml(h.course || '') + warn + '</option>';
      }).join('');
  row.style.display = '';
}

/* Link/unlink session during round -- called from inline picker */
function lrLinkSession(id) {
  if (!lrState) return;
  lrState.linkedSessionId = id || null;
  _lrSessionCache = { id: null, data: null }; /* invalidate cache */
  lrRenderHole();
  _lrPersist();
}

/* Toggle bag card open/closed */
function lrToggleSessionBag() {
  if (!lrState) return;
  lrState._sessionBagOpen = !lrState._sessionBagOpen;
  lrRenderHole();
  _lrPersist();
}

/* Build the caddie companion HTML injected into the hole scroll */
function _lrCaddieCompanionHtml() {
  if (!lrState) return '';
  var sid = lrState.linkedSessionId;

  /* Mid-round link picker button */
  var matches = _lrMatchingSessions(lrState.courseName || '');
  var pickerHtml = '<div style="margin-top:8px;border-top:1px solid var(--br);padding-top:8px">'
    + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
    + '<span style="font-size:.54rem;text-transform:uppercase;letter-spacing:.08em;color:var(--tx3)">\uD83E\uDD16 Caddie Session</span>';

  if (matches.length) {
    var tee = lrState.tee || '';
    pickerHtml += '<select style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--br);border-radius:4px;'
      + 'color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.65rem;padding:3px 6px;outline:none"'
      + ' onchange="lrLinkSession(this.value)">'
      + '<option value="">\u2014 None \u2014</option>'
      + matches.map(function(h) {
          var warn = tee && h.tee && h.tee !== tee ? ' (\u26A0 ' + escHtml(h.tee) + ' tee)' : '';
          var sel  = h.id === sid ? ' selected' : '';
          return '<option value="' + escHtml(h.id) + '"' + sel + '>' + escHtml(h.date) + ' \u00B7 ' + escHtml(h.course || '') + warn + '</option>';
        }).join('')
      + '</select>';
  } else if (sid) {
    pickerHtml += '<button class="btn sec" style="font-size:.58rem;padding:2px 8px" onclick="lrLinkSession(\'\')">Unlink</button>';
  } else {
    pickerHtml += '<span style="font-size:.6rem;color:var(--tx3)">No matching sessions for this course</span>';
  }
  pickerHtml += '</div></div>';

  if (!sid) return pickerHtml;

  var data = _lrParseSession(sid);
  if (!data) return pickerHtml;

  var out = pickerHtml;

  /* Tee mismatch warning */
  if (data.sessionTee && lrState.tee && data.sessionTee !== lrState.tee) {
    out += '<div style="font-size:.6rem;color:var(--danger);padding:4px 0">'
      + '\u26A0 Session is for ' + escHtml(data.sessionTee) + ' tees \u2014 you are playing ' + escHtml(lrState.tee) + '</div>';
  }

  /* Optimised Bag card */
  if (data.bagLines.length) {
    var bagOpen = lrState._sessionBagOpen;
    var arrow   = bagOpen ? '\u25B2' : '\u25BC';
    out += '<div style="border:1px solid var(--br);border-radius:6px;margin-top:8px;overflow:hidden">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;'
      + 'cursor:pointer;background:var(--sf)" onclick="lrToggleSessionBag()">'
      + '<span style="font-size:.62rem;font-weight:600;color:var(--tx2)">\uD83C\uDF4E Optimised Bag</span>'
      + '<span style="font-size:.6rem;color:var(--tx3)">' + arrow + '</span></div>';
    if (bagOpen) {
      out += '<div style="padding:6px 10px 8px">';
      data.bagLines.forEach(function(l) {
        var m = l.match(/^(\d+)\.\s+(.+?)\s+\u2014\s+([0-9\u2013\-]+ yds)\s+(.+)/);
        if (m) {
          out += '<div style="display:flex;gap:6px;font-size:.62rem;padding:2px 0;border-bottom:1px solid var(--br)">'
            + '<span style="color:var(--tx3);width:16px">' + escHtml(m[1]) + '.</span>'
            + '<span style="flex:1;color:var(--tx)">' + escHtml(m[2]) + '</span>'
            + '<span style="color:var(--ac2);white-space:nowrap">' + escHtml(m[3]) + '</span>'
            + '<span style="color:var(--tx3);font-size:.58rem;text-align:right;max-width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(m[4]) + '</span>'
            + '</div>';
        } else {
          out += '<div style="font-size:.62rem;color:var(--tx2);padding:2px 0">' + escHtml(l) + '</div>';
        }
      });
      out += '</div>';
    }
    out += '</div>';
  }

  /* Hole Advice card */
  var holeNum = lrState.holes[lrState.curHole] ? lrState.holes[lrState.curHole].n : null;
  var advice  = holeNum ? data.holeMap[holeNum] : null;
  if (advice) {
    out += '<div style="border:1px solid var(--ac2);border-radius:6px;margin-top:8px;padding:8px 10px;background:var(--sf)">'
      + '<div style="font-size:.54rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ac2);margin-bottom:4px">'
      + 'Hole ' + advice.num + (advice.par ? ' \u00B7 Par ' + escHtml(advice.par) : '')
      + (advice.yds ? ' \u00B7 ' + escHtml(advice.yds) + ' yds' : '') + '</div>'
      + (advice.strokes ? '<div style="font-size:.65rem;font-weight:600;color:var(--tx);margin-bottom:3px">'
          + escHtml(advice.strokes) + '</div>' : '')
      + (advice.advice ? '<div style="font-size:.62rem;color:var(--tx2);line-height:1.45">'
          + escHtml(advice.advice) + '</div>' : '')
      + '</div>';
  }

  return out;
}

/* ============================================================================
   G2 -- In-round map view. All functions prefixed _lrMap*.
   State lives on lrState for persistence; MapLibre instance + GPS watch kept
   module-local to avoid serialising DOM handles. Geometry persisted separately
   to 'gordy:activeRoundGeo' (written once at load; cleared on round end).
   ============================================================================ */

var _lrMapInstance    = null;    /* MapLibre Map */
var _lrMapGeo         = null;    /* {holes, polygons, center, bounds} */
var _lrGpsWatchId     = null;
var _lrUserMarker     = null;    /* maplibregl.Marker */
var _lrTargetMarker   = null;    /* maplibregl.Marker -- G2b retained for legacy unmount; no longer placed */
/* G2b additions */
var _lrTeeMarker      = null;    /* draggable tee maplibregl.Marker */
var _lrSearchMap      = null;    /* map instance inside entry modal */
var _lrSearchMarker   = null;    /* center-hint marker on entry modal */
/* G2b-R additions */
var _lrAimMarker      = null;    /* draggable aim reticle */
var _lrUserLonLat     = null;    /* [lon, lat] latest GPS fix */
var _lrSearchResults  = [];      /* course picker results, indexed by picker buttons */

function _lrMapHasGeotag() {
  if (!lrState || !lrState.courseId) return false;
  var c = courses.find(function(x){ return x.id === lrState.courseId; });
  return !!(c && c.osmCenter && c.osmCenter.length === 2
    && isFinite(c.osmCenter[0]) && isFinite(c.osmCenter[1]));
}

/* G2b -- OBSOLETE. Replaced by full-screen search modal (_lrMapSearchModalOpen).
   Original G2 prompt trio preserved in comment per "comment, don't delete" rule.
-------------------------------------------------------------------------------
function _lrMapPromptIfNeeded() {
  if (!lrState || lrState._mapPromptSeen) return;
  var banner = document.createElement('div');
  banner.id = 'lrMapPrompt';
  banner.style.cssText = 'position:absolute;top:10px;left:10px;right:10px;z-index:500;'
    + 'background:var(--bg);border:1px solid var(--ac);border-radius:8px;padding:12px;'
    + 'font-family:\'DM Mono\',monospace;font-size:.7rem;color:var(--tx);box-shadow:0 4px 12px rgba(0,0,0,.3)';
  if (_lrMapHasGeotag()) {
    banner.innerHTML =
      '<div style="margin-bottom:8px">\uD83D\uDDFA Load course map for this round?</div>'
      + '<div style="font-size:.6rem;color:var(--tx3);margin-bottom:10px">Shows holes, greens, and your GPS location.</div>'
      + '<div style="display:flex;gap:6px;justify-content:flex-end">'
      + '<button class="btn sec" style="font-size:.65rem;padding:4px 12px" onclick="_lrMapPromptDismiss()">Skip</button>'
      + '<button class="btn" style="font-size:.65rem;padding:4px 12px" onclick="_lrMapPromptAccept()">Load map</button>'
      + '</div>';
  } else {
    banner.innerHTML =
      '<div style="margin-bottom:8px">\uD83D\uDDFA Course not pinned to a location</div>'
      + '<div style="font-size:.6rem;color:var(--tx3);margin-bottom:10px">Pin from Courses tab to enable the map.</div>'
      + '<div style="display:flex;gap:6px;justify-content:flex-end">'
      + '<button class="btn sec" style="font-size:.65rem;padding:4px 12px" onclick="_lrMapPromptDismiss()">OK</button>'
      + '</div>';
  }
  var screen = document.getElementById('lrHoleScreen');
  if (screen) screen.appendChild(banner);
}
function _lrMapPromptDismiss() {
  var b = document.getElementById('lrMapPrompt');
  if (b) b.remove();
  if (lrState) { lrState._mapPromptSeen = true; _lrPersist(); }
}
function _lrMapPromptAccept() {
  var b = document.getElementById('lrMapPrompt');
  if (b) b.remove();
  if (lrState) { lrState._mapPromptSeen = true; _lrPersist(); }
  _lrMapLoadForRound();
}
------------------------------------------------------------------------------- */

/* G2b -- Full-screen map-search modal. Shown once per round at round start
   (skippable). Offers two entry paths: pan map + "Load here", or GPS + "Use
   my location". Both end up calling _lrMapLoadForRoundFromCenter(lon,lat).
   Skip closes the modal and leaves the round in classic (non-map) view. */
function _lrMapSearchModalOpen() {
  if (!lrState || lrState._mapSearchDone) return;
  /* Reuse existing geotag if the course was pre-pinned: start the pan map there. */
  var start = null;
  if (_lrMapHasGeotag()) {
    var c = courses.find(function(x){ return x.id === lrState.courseId; });
    if (c && c.osmCenter) start = [c.osmCenter[0], c.osmCenter[1]];
  }
  var overlay = document.createElement('div');
  overlay.id = 'lrMapSearchOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg);'
    + 'display:flex;flex-direction:column;font-family:\'DM Mono\',monospace';
  overlay.innerHTML =
      '<div style="padding:10px 12px;border-bottom:1px solid var(--br);display:flex;'
    +   'justify-content:space-between;align-items:center;gap:10px">'
    +   '<div>'
    +     '<div style="font-size:.82rem;color:var(--tx);font-weight:600">Locate course</div>'
    +     '<div style="font-size:.58rem;color:var(--tx3);margin-top:2px">'
    +       'Pan the map or use GPS. Optional \u2014 skip to use classic scoring.'
    +     '</div>'
    +   '</div>'
    +   '<button class="btn sec" style="font-size:.65rem;padding:5px 12px" '
    +     'onclick="_lrMapSearchSkip()">Skip</button>'
    + '</div>'
    + '<div id="lrSearchCanvas" style="flex:1;min-height:0;background:#111;position:relative">'
    +   '<div id="lrSearchCrosshair" style="position:absolute;left:50%;top:50%;'
    +     'width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;z-index:10;'
    +     'border:2px solid #f1c40f;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.35)"></div>'
    +   '<div id="lrSearchStatus" style="position:absolute;left:10px;right:10px;top:10px;'
    +     'z-index:11;padding:8px 10px;background:rgba(0,0,0,.55);border-radius:6px;'
    +     'color:#fff;font-size:.62rem;display:none"></div>'
    + '</div>'
    + '<div style="padding:10px 12px;border-top:1px solid var(--br);display:flex;gap:8px">'
    +   '<button class="btn" style="flex:1;font-size:.68rem;padding:9px 10px" '
    +     'onclick="_lrMapDoPanLoad()">\uD83D\uDCCD Load course here</button>'
    +   '<button class="btn sec" style="flex:1;font-size:.68rem;padding:9px 10px" '
    +     'onclick="_lrMapDoGpsLoad()">\uD83D\uDCE1 Use my GPS</button>'
    + '</div>';
  document.body.appendChild(overlay);
  /* Mount map inside the overlay. Slight delay so flex sizing is applied first. */
  setTimeout(function(){
    try {
      var el = document.getElementById('lrSearchCanvas');
      if (!el) return;
      _lrSearchMap = geomCreateMap(el, { center: start || [-0.1, 51.5], zoom: start ? 15 : 3 });
    } catch(e) {
      _lrSearchSetStatus('Map failed to initialise: ' + (e && e.message ? e.message : 'unknown'), true);
    }
  }, 0);
}

function _lrSearchSetStatus(msg, isErr) {
  var el = document.getElementById('lrSearchStatus');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.style.background = isErr ? 'rgba(180,40,40,.75)' : 'rgba(0,0,0,.55)';
  el.textContent = msg;
}

function _lrMapSearchModalClose() {
  var o = document.getElementById('lrMapSearchOverlay');
  if (o) o.remove();
  if (_lrSearchMap) { try { _lrSearchMap.remove(); } catch(e) {} _lrSearchMap = null; }
  _lrSearchMarker = null;
  if (lrState) { lrState._mapSearchDone = true; _lrPersist(); }
}

function _lrMapSearchSkip() {
  _lrMapSearchModalClose();
}

async function _lrMapDoPanLoad() {
  if (!_lrSearchMap) return;
  var c = _lrSearchMap.getCenter();
  await _lrMapLoadForRoundFromCenter(c.lng, c.lat);
}

async function _lrMapDoGpsLoad() {
  _lrSearchSetStatus('Getting GPS fix\u2026', false);
  try {
    var pos = await geomGetCurrentPosition();  /* [lon, lat, accuracy] */
    if (_lrSearchMap) _lrSearchMap.flyTo({ center: [pos[0], pos[1]], zoom: 16 });
    await _lrMapLoadForRoundFromCenter(pos[0], pos[1]);
  } catch (err) {
    _lrSearchSetStatus('GPS failed: ' + (err && err.message ? err.message : 'unknown') + '. Pan the map and try again.', true);
  }
}

/* Shared loader: search for courses near center first, then either auto-load (1 result)
   or show a picker (>1 results). Both paths use geomLoadByCourse for bounded fetch.
   Failure => keep modal open with inline error; user can retry or skip. */
async function _lrMapLoadForRoundFromCenter(lon, lat) {
  _lrSearchSetStatus('Searching for courses\u2026', false);
  try {
    var results = await geomSearchByLocation(lon, lat, 2500);
    if (!results || !results.length) {
      _lrSearchSetStatus('No golf courses found within 2500m. Pan closer or try GPS.', true);
      return;
    }
    if (results.length === 1) {
      /* Single course — load immediately, no picker needed */
      await _lrMapLoadCourseById(results[0].osmId, results[0].center);
      return;
    }
    /* Multiple courses — store results and show picker */
    _lrSearchResults = results;
    _lrSearchSetStatus('', false);
    var el = document.getElementById('lrSearchStatus');
    if (el) {
      el.style.display = 'block';
      el.style.background = 'rgba(0,0,0,.72)';
      el.innerHTML =
        '<div style="font-size:.62rem;color:#fff;margin-bottom:6px">Multiple courses found \u2014 select one:</div>'
        + results.map(function(r, i) {
          return '<button onclick="_lrMapPickCourse(' + i + ')" '
            + 'style="display:block;width:100%;text-align:left;background:rgba(255,255,255,.1);'
            + 'border:1px solid rgba(255,255,255,.2);border-radius:4px;color:#fff;'
            + 'font-family:\'DM Mono\',monospace;font-size:.62rem;padding:6px 8px;'
            + 'margin-bottom:4px;cursor:pointer">'
            + escHtml(r.name) + '</button>';
        }).join('');
    }
  } catch (err) {
    _lrSearchSetStatus('Search failed: ' + (err && err.message ? err.message : 'unknown') + '. Retry or skip.', true);
  }
}

/* Called from picker buttons with index into _lrSearchResults. */
async function _lrMapPickCourse(idx) {
  var r = _lrSearchResults && _lrSearchResults[idx];
  if (!r) { _lrSearchSetStatus('Invalid selection.', true); return; }
  _lrSearchSetStatus('Loading course geometry\u2026', false);
  await _lrMapLoadCourseById(r.osmId, r.center || null);
}

/* Inner loader shared by single-result auto-load and picker selection.
   Uses geomLoadByCourse (bounded fetch); falls back to geomLoadByCenter on NO_COURSE_BOUNDARY. */
async function _lrMapLoadCourseById(osmId, center) {
  try {
    var geo = await geomLoadByCourse(osmId, center || null);
    if (!geo || !geo.holes || Object.keys(geo.holes).length === 0) {
      _lrSearchSetStatus('No hole geometry found for this course. Try another or skip.', true);
      return;
    }
    _lrMapGeo = geo;
    try { localStorage.setItem('gordy:activeRoundGeo', JSON.stringify(geo)); } catch(e) {}
    if (lrState) { lrState._mapOpen = true; lrState._mapSearchDone = true; _lrPersist(); }
    _lrMapSearchModalClose();
    lrRenderHole();
  } catch (err) {
    if (err && err.message === 'NO_COURSE_BOUNDARY' && center) {
      /* Boundary unavailable — fall back to radial fetch */
      try {
        var geoFb = await geomLoadByCenter(center[0], center[1], 1500);
        if (!geoFb || !geoFb.holes || Object.keys(geoFb.holes).length === 0) {
          _lrSearchSetStatus('No hole geometry found here. Try another or skip.', true);
          return;
        }
        _lrMapGeo = geoFb;
        try { localStorage.setItem('gordy:activeRoundGeo', JSON.stringify(geoFb)); } catch(e) {}
        if (lrState) { lrState._mapOpen = true; lrState._mapSearchDone = true; _lrPersist(); }
        _lrMapSearchModalClose();
        lrRenderHole();
      } catch (err2) {
        _lrSearchSetStatus('Load failed: ' + (err2 && err2.message ? err2.message : 'unknown') + '. Retry or skip.', true);
      }
    } else {
      _lrSearchSetStatus('Load failed: ' + (err && err.message ? err.message : 'unknown') + '. Retry or skip.', true);
    }
  }
}

async function _lrMapLoadForRound() {
  if (!lrState || !lrState.courseId) return;
  var c = courses.find(function(x){ return x.id === lrState.courseId; });
  /* G3-FIX -- branch on osmCourseId for bounded fetch; silent legacy fallback */
  if (!c || (!c.osmCourseId && !c.osmCenter)) return;
  var hint = document.getElementById('lrMapLoadHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'lrMapLoadHint';
    hint.style.cssText = 'position:absolute;top:10px;left:10px;right:10px;z-index:500;'
      + 'background:var(--bg);border:1px solid var(--br);border-radius:8px;padding:10px;'
      + 'font-family:\'DM Mono\',monospace;font-size:.65rem;color:var(--tx3);text-align:center';
    var sc = document.getElementById('lrHoleScreen');
    if (sc) sc.appendChild(hint);
  }
  hint.textContent = 'Loading course geometry...';
  try {
    var geo;
    /* G3-FIX: original single fetch commented out below per "comment, don't delete" rule:
    var geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500); */
    if (c.osmCourseId) {
      try {
        geo = await geomLoadByCourse(c.osmCourseId, c.osmCenter || null);
      } catch (e) {
        if (e.message === 'NO_COURSE_BOUNDARY' && c.osmCenter) {
          console.warn('[geomap] No course boundary available; falling back to radial fetch.');
          geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500);
        } else {
          throw e;
        }
      }
    } else if (c.osmCenter) {
      if (!window._lrMapWarnedLegacy) {
        console.warn('[geomap] Course missing osmCourseId; using legacy radial fetch. Re-geotag for accurate boundaries.');
        window._lrMapWarnedLegacy = true;
      }
      geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500);
    }
    _lrMapGeo = geo;
    try { localStorage.setItem('gordy:activeRoundGeo', JSON.stringify(geo)); } catch(e) {}
    lrState._mapOpen = true;
    _lrPersist();
    hint.remove();
    lrRenderHole();
  } catch (err) {
    hint.style.color = 'var(--danger)';
    hint.textContent = 'Map load failed: ' + (err && err.message ? err.message : 'unknown');
    setTimeout(function(){ if (hint && hint.parentNode) hint.remove(); }, 4000);
  }
}

function _lrMapRestoreFromStorage() {
  if (!lrState || !lrState._mapOpen) return;
  if (_lrMapGeo) return;  /* already hydrated */
  try {
    var raw = localStorage.getItem('gordy:activeRoundGeo');
    if (raw) _lrMapGeo = JSON.parse(raw);
  } catch(e) { _lrMapGeo = null; }
  if (!_lrMapGeo) lrState._mapOpen = false;  /* storage gone -- downgrade to classic view */
}

function _lrMapClearStorage() {
  try { localStorage.removeItem('gordy:activeRoundGeo'); } catch(e) {}
  _lrMapGeo = null;
}

/* Banner: hole number, par, yardage, stroke index. Static; re-rendered per hole. */
function _lrMapBannerHtml(h) {
  return '<div style="display:flex;justify-content:space-between;align-items:center;'
    + 'padding:10px 12px;background:var(--sf);border-radius:8px;margin-bottom:8px;'
    + 'font-family:\'DM Mono\',monospace">'
    + '<div><span style="font-size:.5rem;color:var(--tx3);text-transform:uppercase">Hole</span>'
    + '<div style="font-size:1.1rem;font-weight:600;color:var(--tx)">' + h.n + '</div></div>'
    + '<div><span style="font-size:.5rem;color:var(--tx3);text-transform:uppercase">Par</span>'
    + '<div style="font-size:.9rem;color:var(--tx)">' + h.par + '</div></div>'
    + '<div><span style="font-size:.5rem;color:var(--tx3);text-transform:uppercase">Yds</span>'
    + '<div style="font-size:.9rem;color:var(--tx)">' + (h.yards || '\u2014') + '</div></div>'
    + '<div><span style="font-size:.5rem;color:var(--tx3);text-transform:uppercase">SI</span>'
    + '<div style="font-size:.9rem;color:var(--tx)">' + (h.handicap || '\u2014') + '</div></div>'
    + '</div>';
}

function _lrMapModeDropdownHtml() {
  var mode = (lrState && lrState._mapMode) || 'simple';
  return '<select onchange="_lrMapSetMode(this.value)" style="background:var(--bg);border:1px solid var(--br);'
    + 'border-radius:4px;color:var(--tx);font-family:\'DM Mono\',monospace;font-size:.65rem;padding:3px 8px;outline:none">'
    + '<option value="simple"' + (mode==='simple'?' selected':'') + '>Simple</option>'
    + '<option value="advanced"' + (mode==='advanced'?' selected':'') + '>Advanced</option>'
    + '</select>';
}

/* G2b -- Chain of segment distances. tee(or GPS) -> wp[0] -> ... -> wp[last] -> green.
   Each waypoint row has a remove button. Clear-all button at the bottom.
   Rendered inside a div#lrPathPanel so it can be patched in-place by _lrRefreshPathUI.

   G2 original preserved below:
function _lrDistancesHtml() {
  var lines = [];
  var hole = _lrMapGeo && _lrMapGeo.holes ? _lrCurHoleGeo() : null;
  var green = hole && hole.green;
  var user = _lrUserLonLat;
  var target = lrState && lrState._mapSelectedPoint;
  function line(label, val) {
    return '<div style="display:flex;justify-content:space-between;font-size:.62rem;padding:2px 0">'
      + '<span style="color:var(--tx3)">' + label + '</span>'
      + '<span style="color:var(--tx)">' + (val === null ? '\u2014' : val + ' yds') + '</span></div>';
  }
  lines.push(line('You \u2192 Target', (user && target) ? geomDistanceYds(user, target) : null));
  lines.push(line('Target \u2192 Green', (target && green) ? geomDistanceYds(target, green) : null));
  lines.push(line('You \u2192 Green', (user && green) ? geomDistanceYds(user, green) : null));
  return '<div style="padding:8px 10px;background:var(--sf);border-radius:6px;margin-top:6px">' + lines.join('') + '</div>';
}
*/
/* G2b-R -- Distance rendering moved to floating on-map overlays (_lrUpdateFloatingDists).
   This function now returns an empty string; kept so any lingering caller is a no-op.

   G2b (multi-waypoint chain) preserved below:
function _lrDistancesHtml() {
  var hole = _lrMapGeo && _lrMapGeo.holes ? _lrCurHoleGeo() : null;
  var green = hole && hole.green;
  var teeGeo = hole && hole.tee;
  var userTee = lrState && lrState._mapTeeLonLat;
  var path = (lrState && lrState._mapPath) || [];
  var gps = _lrUserLonLat;
  var gpsOn = !!(lrState && lrState._gpsOn && gps);
  var startPt = gpsOn ? gps : (userTee || teeGeo);
  var startLabel = gpsOn ? 'GPS' : (userTee ? 'Tee*' : 'Tee');
  function rowHtml(label, val, removeIdx) { ... }
  // rows + totalRow + clearBtn + hint ...
  return '<div id="lrPathPanel" ...>' + rows.join('') + totalRow + clearBtn + hint + '</div>';
}
*/
function _lrDistancesHtml() { return ''; }

function _lrCurHoleGeo() {
  if (!_lrMapGeo || !_lrMapGeo.holes) return null;
  var want = String(lrState.holes[lrState.curHole].n);
  for (var key in _lrMapGeo.holes) {
    if (String(_lrMapGeo.holes[key].ref) === want) return _lrMapGeo.holes[key];
  }
  return null;
}

/* G2b -- Full-bleed map layout.
   Top: persistent banner (hole/par/yds/SI) — reuses _lrMapBannerHtml
   Middle: map canvas filling remaining height
   Bottom sheet: collapsible; simple mode ~30vh, advanced ~85vh (scrollable)
   Distance chain + clear button live inside the sheet header so they're always
   visible even when the sheet is collapsed.
   (Bottom round-nav banner lrPrev/lrNext is rendered by classic DOM outside scroll.)

   G2 original preserved below:
function _lrMapPanelHtml(h, pi, shared) {
  var collapsed = !!(lrState && lrState._scoringCollapsed);
  var mapH = collapsed ? '60vh' : '40vh';
  var scoreMode = (lrState && lrState._mapMode) || 'simple';
  var scoreHtml = '';
  if (scoreMode === 'simple') {
    scoreHtml = shared
      ? lrScoreBlock(lrState.players[0], lrState.curHole, h, 0, true)
      : lrScoreBlock(lrState.players[pi], lrState.curHole, h, pi, false);
  } else {
    scoreHtml = _lrAdvancedHtml(lrState.curHole, shared ? 0 : pi, !!shared);
    if (!_lrAdvancedOpen) { _lrAdvancedOpen = true; scoreHtml = _lrAdvancedHtml(lrState.curHole, shared ? 0 : pi, !!shared); }
  }
  var gpsBtn = ...; var collapseBtn = ...; var mapExitBtn = ...;
  return _lrMapBannerHtml(h)
    + '<div ...>' + _lrMapModeDropdownHtml() + gpsBtn + collapseBtn + mapExitBtn + '</div>'
    + '<div id="lrMapCanvas" style="...height:' + mapH + ';..."></div>'
    + _lrDistancesHtml()
    + (collapsed ? '' : '<div style="margin-top:10px">' + scoreHtml + '</div>');
}
*/
/* G2b-R -- Full-viewport map. Map = the page. Banners overlay; no boxed canvas.
   Compact top banner (hole/par/yds/SI pill) over map. Bottom sheet for scoring.
   Floating distance bubbles rendered via _lrUpdateFloatingDists after mount.
   Classic bottom nav (Prev/hole-pill/Next) lives in outer DOM, unchanged.

   G2b (boxed-map version) preserved below:
function _lrMapPanelHtml(h, pi, shared) {
  var sheetOpen = !!(lrState && lrState._mapSheetOpen);
  var scoreMode = (lrState && lrState._mapMode) || 'simple';
  var sheetH = sheetOpen ? (scoreMode === 'advanced' ? '85vh' : '34vh') : '0px';
  var scoreHtml = '';
  if (sheetOpen) {
    if (scoreMode === 'simple') { ... } else { ... }
  }
  var gpsBtn, zoomGreenBtn, exitBtn, sheetToggleLabel;
  return '<div id="lrMapRoot" style="position:relative;width:100%;height:72vh;...">'
    + _lrMapBannerHtml(h)
    + '<div ... floating controls>gps/green/exit</div>'
    + '<div id="lrMapCanvas" style="flex:1;..."></div>'
    + '<div id="lrMapSheet" ...>' + mode+toggle + distances + scoreHtml + '</div>'
    + '</div>';
}
*/
function _lrMapPanelHtml(h, pi, shared) {
  var sheetOpen = !!(lrState && lrState._mapSheetOpen);
  var scoreMode = (lrState && lrState._mapMode) || 'simple';
  /* Simple mode keeps map mostly visible; advanced takes more room. */
  var sheetH = sheetOpen ? (scoreMode === 'advanced' ? '75vh' : '30vh') : '0px';

  var scoreHtml = '';
  if (sheetOpen) {
    if (scoreMode === 'simple') {
      scoreHtml = shared
        ? lrScoreBlock(lrState.players[0], lrState.curHole, h, 0, true)
        : lrScoreBlock(lrState.players[pi], lrState.curHole, h, pi, false);
    } else {
      scoreHtml = _lrAdvancedHtml(lrState.curHole, shared ? 0 : pi, !!shared);
      if (!_lrAdvancedOpen) { _lrAdvancedOpen = true; scoreHtml = _lrAdvancedHtml(lrState.curHole, shared ? 0 : pi, !!shared); }
    }
  }

  var gpsBtn = (lrState && lrState._gpsOn)
    ? '<button class="btn" style="font-size:.62rem;padding:5px 10px;border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,.4)" onclick="_lrMapGpsToggle()">\uD83D\uDCE1</button>'
    : '<button class="btn sec" style="font-size:.62rem;padding:5px 10px;border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,.4);opacity:.9" onclick="_lrMapGpsToggle()">\uD83D\uDCE1</button>';
  var zoomGreenBtn = '<button class="btn sec" style="font-size:.62rem;padding:5px 10px;border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,.4);opacity:.9" onclick="_lrZoomGreen()">\u26F3</button>';
  var minBtn = '<button class="btn sec" style="font-size:.62rem;padding:5px 10px;border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,.4);opacity:.9" onclick="_lrMapMinimize()" title="Minimize">\u2014</button>';

  var sheetToggleLabel = sheetOpen ? '\u2B07 Close' : '\u2B06 Score';

  /* Compact top banner (one-row pill) replaces the tall _lrMapBannerHtml box. */
  var hole = lrState.holes[lrState.curHole];
  var holeN = hole ? hole.n : '-';
  var par = hole ? hole.par : '-';
  var yds = hole ? (hole.yds || '-') : '-';
  var si  = hole ? (hole.si  || '-') : '-';
  var topBanner =
      '<div style="position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:30;'
    +   'background:rgba(0,0,0,.72);border-radius:22px;padding:6px 14px;'
    +   'display:flex;align-items:center;gap:14px;color:#fff;font-family:\'DM Mono\',monospace;'
    +   'font-size:.68rem;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.4)">'
    +   '<span style="font-weight:700;font-size:.78rem">' + holeN + '</span>'
    +   '<span style="opacity:.65">Par</span><span style="font-weight:600">' + par + '</span>'
    +   '<span style="opacity:.65">Yds</span><span style="font-weight:600">' + yds + '</span>'
    +   '<span style="opacity:.65">SI</span><span style="font-weight:600">' + si + '</span>'
    + '</div>';

  /* Outer root: fixed to fill viewport minus classic bottom-nav area (which lives
     in outer DOM). Uses absolute inset to overlay within the lrScroll container. */
  return ''
    + '<div id="lrMapRoot" style="position:relative;width:100%;height:76vh;overflow:hidden;'
    +   'border-radius:10px;background:#111">'
    +   topBanner
    /* Floating right-side controls */
    +   '<div style="position:absolute;top:8px;right:8px;z-index:30;'
    +     'display:flex;flex-direction:column;gap:6px;align-items:flex-end">'
    +     minBtn + gpsBtn + zoomGreenBtn
    +   '</div>'
    /* Floating distance bubbles (populated by _lrUpdateFloatingDists) */
    +   '<div id="lrAimDistBubble" style="position:absolute;z-index:25;'
    +     'background:rgba(0,0,0,.78);color:#fff;border-radius:999px;'
    +     'padding:4px 10px;font-family:\'DM Mono\',monospace;font-size:.68rem;'
    +     'font-weight:700;pointer-events:none;transform:translate(-50%,-140%);'
    +     'box-shadow:0 2px 8px rgba(0,0,0,.45);display:none">&mdash;</div>'
    +   '<div id="lrPlayerDistPill" style="position:absolute;left:10px;bottom:10px;z-index:25;'
    +     'background:#fff;color:#111;border-radius:999px;'
    +     'padding:5px 12px 5px 5px;font-family:\'DM Mono\',monospace;font-size:.66rem;'
    +     'font-weight:700;display:flex;align-items:center;gap:8px;'
    +     'box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:none">'
    +     '<span style="background:#111;color:#fff;border-radius:999px;padding:3px 9px;font-size:.68rem">&mdash;</span>'
    +     '<span style="font-size:.56rem;color:#444">to aim</span>'
    +   '</div>'
    /* Map canvas fills everything */
    +   '<div id="lrMapCanvas" style="position:absolute;inset:0;background:#111"></div>'
    /* Bottom sheet (overlays bottom of map area) */
    +   '<div id="lrMapSheet" style="position:absolute;left:0;right:0;bottom:0;z-index:28;'
    +     'background:var(--bg);border-top:1px solid var(--br);'
    +     'display:flex;flex-direction:column;max-height:85vh;'
    +     'box-shadow:0 -4px 14px rgba(0,0,0,.45)">'
    +     '<div style="display:flex;justify-content:space-between;align-items:center;'
    +       'padding:6px 10px;gap:8px;border-bottom:' + (sheetOpen ? '1px solid var(--br)' : 'none') + '">'
    +       _lrMapModeDropdownHtml()
    +       '<button class="btn" style="font-size:.62rem;padding:4px 12px;border-radius:16px" '
    +         'onclick="_lrMapToggleSheet()">' + sheetToggleLabel + '</button>'
    +     '</div>'
    +     (sheetOpen
        ? '<div style="flex:1;overflow-y:auto;padding:8px 10px;max-height:' + sheetH + '">'
          + scoreHtml + '</div>'
        : '')
    +   '</div>'
    + '</div>';
}

function _lrMapMount() {
  if (!_lrMapGeo) return;
  var el = document.getElementById('lrMapCanvas');
  if (!el) return;
  /* If an existing instance's container was replaced by innerHTML, rebuild */
  if (_lrMapInstance && _lrMapInstance.getContainer && _lrMapInstance.getContainer() !== el) {
    try { _lrMapInstance.remove(); } catch(e) {}
    _lrMapInstance = null;
    _lrUserMarker = null;
    _lrTargetMarker = null;
    _lrTeeMarker = null;    /* G2b */
    _lrAimMarker = null;    /* G2b-R */
  }
  if (!_lrMapInstance) {
    /* G2b-R -- initial zoom tightened from 16 to 18 (tee-level satellite detail). */
    _lrMapInstance = geomCreateMap(el, { center: _lrMapGeo.center, zoom: 17 });
    /* G2b-R2 -- inline polygon-source set, skipping geomRenderGeometry's fitBounds
       which would zoom out to the entire course. We only want hole-level framing
       in live round; _lrMapShowHole below handles the per-hole flyTo. */
    var _lrApplyPolys = function(){
      try {
        var src = _lrMapInstance.getSource('course-polygons');
        if (src && _lrMapGeo && _lrMapGeo.polygons) src.setData(_lrMapGeo.polygons);
      } catch(e) {}
    };
    _lrMapInstance.on('load', function(){
      _lrApplyPolys();
      _lrMapShowHole(lrState.curHole + 1);
      _lrPlaceTeeMarker();
      _lrPlaceAimMarker();           /* G2b-R */
      _lrRenderAimLine();            /* G2b-R */
      _lrUpdateFloatingDists();      /* G2b-R */
    });
    if (_lrMapInstance.isStyleLoaded && _lrMapInstance.isStyleLoaded()) {
      _lrApplyPolys();
      _lrMapShowHole(lrState.curHole + 1);
      _lrPlaceTeeMarker();
      _lrPlaceAimMarker();
      _lrRenderAimLine();
      _lrUpdateFloatingDists();
    }
    _lrMapInstance.on('click', _lrMapOnClick);
    /* G2b-R -- floating aim-distance bubble tracks aim marker on map move/zoom. */
    _lrMapInstance.on('move', _lrUpdateFloatingDists);
  } else {
    /* Same instance being re-shown (e.g. after hole change returns scroll html) */
    _lrPlaceTeeMarker();
    _lrPlaceAimMarker();
    _lrRenderAimLine();
    _lrUpdateFloatingDists();
  }
  if (_lrUserLonLat) _lrPlaceUserMarker(_lrUserLonLat);
}

/* G2b-R2 -- per-hole flyTo. Replaces geomShowHole's internal flyTo (zoom 17.5)
   with a single tighter flyTo (zoom 18.5). Avoids competing-flyTo jank. */
function _lrMapShowHole(n) {
  if (!_lrMapInstance || !_lrMapGeo) return;
  try {
    var hole = _lrCurHoleGeo();
    if (hole && hole.tee && hole.green) {
      var brg = geomBearingDeg(hole.tee, hole.green);
      _lrMapInstance.flyTo({ center: hole.tee, zoom: 16, bearing: brg, pitch: 0 });
    }
  } catch(e) {}
}

/* G2b-R -- draggable tee; dragend updates line + floating distances. */
function _lrPlaceTeeMarker() {
  if (!_lrMapInstance || !window.maplibregl) return;
  var hole = _lrCurHoleGeo();
  if (!hole || !hole.tee) return;
  var ll = (lrState && lrState._mapTeeLonLat) || hole.tee;
  if (_lrTeeMarker) { try { _lrTeeMarker.remove(); } catch(e) {} _lrTeeMarker = null; }
  var el = document.createElement('div');
  el.style.cssText = 'width:14px;height:14px;background:#d0d8e0;'
    + 'border:2px solid #fff;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab';
  _lrTeeMarker = new window.maplibregl.Marker({ element: el, draggable: true })
    .setLngLat(ll).addTo(_lrMapInstance);
  _lrTeeMarker.on('dragend', function(){
    var p = _lrTeeMarker.getLngLat();
    if (lrState) {
      lrState._mapTeeLonLat = [p.lng, p.lat];
      _lrPersist();
    }
    _lrRenderAimLine();
    _lrUpdateFloatingDists();
  });
}

/* G2b-R -- aim reticle. Initial position = midpoint of start(tee or user-tee) and green.
   Draggable; drag/dragend update line + floating distances. */
function _lrPlaceAimMarker() {
  if (!_lrMapInstance || !window.maplibregl) return;
  var hole = _lrCurHoleGeo();
  if (!hole || !hole.green) return;
  var startPt = (lrState && lrState._mapTeeLonLat) || hole.tee;
  if (!startPt) return;
  /* Initialize aim at midpoint if not set. */
  if (lrState && !lrState._mapAim) {
    lrState._mapAim = [(startPt[0] + hole.green[0]) / 2, (startPt[1] + hole.green[1]) / 2];
    _lrPersist();
  }
  if (_lrAimMarker) { try { _lrAimMarker.remove(); } catch(e) {} _lrAimMarker = null; }
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
  _lrAimMarker = new window.maplibregl.Marker({ element: el, draggable: true })
    .setLngLat(lrState._mapAim).addTo(_lrMapInstance);
  _lrAimMarker.on('drag', function(){
    var p = _lrAimMarker.getLngLat();
    if (lrState) lrState._mapAim = [p.lng, p.lat];
    _lrRenderAimLine();
    _lrUpdateFloatingDists();
  });
  _lrAimMarker.on('dragend', function(){
    var p = _lrAimMarker.getLngLat();
    if (lrState) {
      lrState._mapAim = [p.lng, p.lat];
      _lrPersist();
    }
  });
}

/* G2b-R -- render the aim line: start(GPS|userTee|geomTee) -> aim -> green. */
function _lrRenderAimLine() {
  if (!_lrMapInstance || !_lrMapGeo) return;
  var hole = _lrCurHoleGeo();
  if (!hole || !hole.green) { try { geomRenderPath(_lrMapInstance, []); } catch(e){} return; }
  var userTee = lrState && lrState._mapTeeLonLat;
  var gpsOn = !!(lrState && lrState._gpsOn && _lrUserLonLat);
  var startPt = gpsOn ? _lrUserLonLat : (userTee || hole.tee);
  var aim = lrState && lrState._mapAim;
  if (!startPt || !aim) { try { geomRenderPath(_lrMapInstance, []); } catch(e){} return; }
  try { geomRenderPath(_lrMapInstance, [startPt, aim, hole.green]); } catch(e) {}
}

/* G2b-R -- update the two floating labels.
   #lrAimDistBubble: yards from aim to green, positioned at aim's screen coords.
   #lrPlayerDistPill: yards from start(GPS|Tee) to aim, bottom-left label. */
function _lrUpdateFloatingDists() {
  if (!_lrMapInstance) return;
  var hole = _lrCurHoleGeo();
  if (!hole || !hole.green) return;
  var aim = lrState && lrState._mapAim;
  var userTee = lrState && lrState._mapTeeLonLat;
  var gpsOn = !!(lrState && lrState._gpsOn && _lrUserLonLat);
  var startPt = gpsOn ? _lrUserLonLat : (userTee || hole.tee);

  var bubble = document.getElementById('lrAimDistBubble');
  var pill   = document.getElementById('lrPlayerDistPill');

  /* Aim -> green bubble. */
  if (bubble) {
    if (aim && hole.green) {
      var aimToGreen = geomDistanceYds(aim, hole.green);
      bubble.textContent = aimToGreen + 'y';
      try {
        var pt = _lrMapInstance.project(aim);
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
    var label = gpsOn ? 'from GPS' : (userTee ? 'from tee*' : 'from tee');
    var startToAim = (startPt && aim) ? geomDistanceYds(startPt, aim) : null;
    pill.innerHTML = ''
      + '<span style="background:#111;color:#fff;border-radius:999px;padding:3px 9px;font-size:.68rem">'
      +   (startToAim === null ? '\u2014' : startToAim + 'y')
      + '</span>'
      + '<span style="font-size:.56rem;color:#444">' + label + '</span>';
  }
}

/* G2b-R -- tap-to-move aim. Cheaper than dragging for small adjustments. */
function _lrMapOnClick(e) {
  if (!lrState) return;
  lrState._mapAim = [e.lngLat.lng, e.lngLat.lat];
  _lrPersist();
  if (_lrAimMarker) {
    try { _lrAimMarker.setLngLat(lrState._mapAim); } catch(err) {}
  } else {
    _lrPlaceAimMarker();
  }
  _lrRenderAimLine();
  _lrUpdateFloatingDists();
}

/* G2b-R -- OBSOLETE stubs. Multi-waypoint handlers retained as comments so nothing
   breaks if a stale DOM reference tries to fire them, but the new single-aim model
   makes them no-ops. Preserved per "comment, don't delete" rule.
function _lrRefreshPathUI() { ... G2b multi-wp in-place patch ... }
function _lrMapRemoveWaypoint(idx) { ... splice from _mapPath ... }
function _lrMapClearPath() { ... _mapPath=[] ... }
*/
function _lrRefreshPathUI() { _lrUpdateFloatingDists(); }
function _lrMapRemoveWaypoint() { /* no-op */ }
function _lrMapClearPath() { /* no-op */ }

/* G2b -- OBSOLETE. Single target marker replaced by path line + draggable tee.
   Original G2 preserved in comment:
function _lrPlaceTargetMarker(ll) {
  if (!_lrMapInstance) return;
  if (_lrTargetMarker) _lrTargetMarker.setLngLat(ll);
  else _lrTargetMarker = new window.maplibregl.Marker({ color: '#f1c40f' }).setLngLat(ll).addTo(_lrMapInstance);
}
*/
function _lrPlaceTargetMarker(ll) { /* no-op */ }

function _lrPlaceUserMarker(ll) {
  if (!_lrMapInstance) return;
  if (_lrUserMarker) _lrUserMarker.setLngLat(ll);
  else _lrUserMarker = new window.maplibregl.Marker({ color: '#4a90e2' }).setLngLat(ll).addTo(_lrMapInstance);
}

/* G2b-R -- generic refresh on GPS tick / external events. */
function _lrRefreshDistances() {
  _lrRenderAimLine();
  _lrUpdateFloatingDists();
}

/* G2b-R -- OBSOLETE multi-waypoint handlers replaced by no-op stubs above.
   Original G2b bodies preserved here per "comment, don't delete" rule:
function _lrMapRemoveWaypoint(idx) {
  if (!lrState || !lrState._mapPath) return;
  if (idx < 0 || idx >= lrState._mapPath.length) return;
  lrState._mapPath.splice(idx, 1);
  _lrPersist();
  _lrRenderActivePath();
  _lrRefreshPathUI();
}
function _lrMapClearPath() {
  if (!lrState) return;
  lrState._mapPath = [];
  _lrPersist();
  _lrRenderActivePath();
  _lrRefreshPathUI();
}
*/

/* G2b-R -- zoom-to-green shortcut. Zoom 19 -> 17.5 (was too tight). */
function _lrZoomGreen() {
  if (!_lrMapInstance) return;
  var hole = _lrCurHoleGeo();
  if (!hole || !hole.green) return;
  _lrMapInstance.flyTo({ center: hole.green, zoom: 17.5, pitch: 0 });
}

/* G2b -- bottom sheet open/close. No full rerender; toggles height only via rerender
   of the sheet section. Cheap because scoreHtml inside is reused; the map instance
   survives the innerHTML swap because lrMapMount detects container reuse. */
function _lrMapToggleSheet() {
  if (!lrState) return;
  lrState._mapSheetOpen = !lrState._mapSheetOpen;
  _lrPersist();
  lrRenderHole();
}

function _lrMapGpsPromptIfNeeded() {
  if (!lrState) return true;
  if (lrState._gpsPrompted) return true;
  var ok = confirm('Enable GPS tracking for this round? Accuracy helps distance estimates.');
  lrState._gpsPrompted = true;
  _lrPersist();
  return ok;
}

function _lrMapGpsToggle() {
  if (!lrState) return;
  if (lrState._gpsOn) {
    /* Turn off */
    if (_lrGpsWatchId != null) { geomStopGpsWatch(_lrGpsWatchId); _lrGpsWatchId = null; }
    if (_lrUserMarker) { try { _lrUserMarker.remove(); } catch(e) {} _lrUserMarker = null; }
    _lrUserLonLat = null;
    lrState._gpsOn = false;
    _lrPersist();
    lrRenderHole();
    return;
  }
  if (!_lrMapGpsPromptIfNeeded()) return;
  _lrGpsWatchId = geomStartGpsWatch(_lrMapOnGpsTick, function(err){
    lrState._gpsOn = false;
    _lrPersist();
    alert('GPS error: ' + (err && err.message ? err.message : 'unknown'));
    lrRenderHole();
  });
  lrState._gpsOn = true;
  _lrPersist();
  lrRenderHole();
}

function _lrMapOnGpsTick(tick) {
  _lrUserLonLat = [tick[0], tick[1]];
  _lrPlaceUserMarker(_lrUserLonLat);
  /* G2b -- cheap refresh: update path geometry + distance panel in place. */
  _lrRefreshDistances();
}

function _lrMapToggleScoring() {
  if (!lrState) return;
  lrState._scoringCollapsed = !lrState._scoringCollapsed;
  _lrPersist();
  lrRenderHole();
}

function _lrMapSetMode(m) {
  if (!lrState) return;
  lrState._mapMode = (m === 'advanced' ? 'advanced' : 'simple');
  _lrPersist();
  lrRenderHole();
}

/* G2b-R -- Once loaded, map persists for the rest of the round. Minimize only.
   No unmount, no state reset. Resume via the floating "Map" pill in classic view.

   G2b original (exit + reset) preserved below:
function _lrMapExit() {
  if (!lrState) return;
  _lrMapUnmount();
  lrState._mapOpen = false;
  lrState._mapPath = [];
  lrState._mapTeeLonLat = null;
  lrState._mapSheetOpen = false;
  lrState._mapSearchDone = false;
  _lrPersist();
  lrRenderHole();
}
*/
function _lrMapMinimize() {
  if (!lrState) return;
  lrState._mapOpen = false;
  _lrPersist();
  lrRenderHole();
}
/* _lrMapExit kept as alias so any legacy caller still works as a minimize. */
function _lrMapExit() { _lrMapMinimize(); }

/* G2b-R -- re-expand the map from classic view. Called from the floating "Map" pill. */
function _lrMapResume() {
  if (!lrState || !_lrMapGeo) return;
  lrState._mapOpen = true;
  _lrPersist();
  lrRenderHole();
}

function _lrMapUnmount() {
  if (_lrGpsWatchId != null) { try { geomStopGpsWatch(_lrGpsWatchId); } catch(e) {} _lrGpsWatchId = null; }
  if (_lrUserMarker) { try { _lrUserMarker.remove(); } catch(e) {} _lrUserMarker = null; }
  if (_lrTargetMarker) { try { _lrTargetMarker.remove(); } catch(e) {} _lrTargetMarker = null; }
  if (_lrTeeMarker) { try { _lrTeeMarker.remove(); } catch(e) {} _lrTeeMarker = null; }  /* G2b */
  if (_lrAimMarker) { try { _lrAimMarker.remove(); } catch(e) {} _lrAimMarker = null; }  /* G2b-R */
  if (_lrMapInstance) { try { _lrMapInstance.remove(); } catch(e) {} _lrMapInstance = null; }
  _lrUserLonLat = null;
}

// -- Expose to window (required for HTML onclick handlers) --
Object.assign(window, {
  lrStartSetup, lrAddPlayer, lrRemovePlayer, lrToggleMe,
  lrOnCourseSelect, lrOnHoleCountChange, lrOnModeChange,
  lrBeginRound, lrCancelSetup,
  lrTogParPicker, lrSetPar, lrSetView, lrSetNetView, lrGoHole,
  lrMinimize, lrExpand, lrUpdatePill,
  lrShowTally, lrShowTallyFromSummary, lrShowHole,
  lrEndRound, lrCancelEndBanner, lrConfirmEnd,
  lrSaveRound, lrCloseRound, lrExportPdf,
  lrDiscardRound, lrConfirmDiscard,
  lrAdj, lrSetGir, lrToggleNote, lrSaveNote,
  lrSetPlayer, lrRenderHole, lrRenderTally, lrShowScreen,
  /* Phase 4: advanced shot logging */
  lrToggleAdvanced, lrSelectZone, lrToggleOb, lrRecordShot,
  lrEditShot, lrDeleteShot, lrDeleteShotConfirm, lrDeleteShotCancel,
  lrCompleteHole, lrToggleFir, lrToggleGir,
  lrSetShotMode, lrSetShotLie, lrSetFlightPath, lrSetClub, lrSetDist,
  lrObConfirm, lrSetOnGreenDist, lrAdjChipPutt, lrToggleHoledOut,
  lrGirPromptAnswer,
  /* Caddie session linking */
  lrLinkSession, lrToggleSessionBag, lrRenderSessionPicker,
  /* Shared PDF helpers */
  _lrRoundSG, _lrRoundFIR, _pdfSharedCSS, _pdfBanner, _pdfFontsLink, _pdfLogoDataUrl,
  /* G2 -- map view (obsolete prompt trio removed; functions still defined as commented-out reference):
     _lrMapPromptIfNeeded, _lrMapPromptDismiss, _lrMapPromptAccept, */
  _lrMapLoadForRound, _lrMapGpsToggle, _lrMapToggleScoring, _lrMapSetMode, _lrMapExit,
  /* G2b -- search modal + path + sheet + green zoom + tee drag handlers */
  _lrMapSearchModalOpen, _lrMapSearchModalClose, _lrMapSearchSkip,
  _lrMapDoPanLoad, _lrMapDoGpsLoad, _lrMapLoadForRoundFromCenter,
  _lrMapPickCourse, _lrMapLoadCourseById,
  _lrMapRemoveWaypoint, _lrMapClearPath, _lrZoomGreen, _lrMapToggleSheet,
  /* G2b-R -- minimize/resume handlers (map persists once loaded) */
  _lrMapMinimize, _lrMapResume,
});
