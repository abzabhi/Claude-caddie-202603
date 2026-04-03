import { uid, today, save, courses, rounds, profile } from './store.js';
import { calcDiff } from './geo.js';
import { renderHandicap } from './rounds.js';

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
};

lrShowScreen('lrHoleScreen');
lrRenderHole();
}

function lrCancelSetup() {
document.getElementById('lrOverlay').classList.remove('active');
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
if(shared) {
  // Scramble / foursomes: one score for the team (use player 0)
  const ts = lrState.players[0].scores[lrState.curHole];
  scroll.innerHTML = lrScoreBlock(lrState.players[0], lrState.curHole, h, 0, true);
} else {
  scroll.innerHTML = lrScoreBlock(player, lrState.curHole, h, pi, false);
}

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
  <div class="card" style="margin-bottom:0">
    <div class="card-title">GIR</div>
    <div style="display:flex;gap:6px;margin-top:4px">
      <button class="lr-tog ${s.gir===true?'on-y':''}" style="flex:1" onclick="lrSetGir(${pi},${holeIdx},true,${shared})">\u2713 Yes</button>
      <button class="lr-tog ${s.gir===false?'on-n':''}" style="flex:1" onclick="lrSetGir(${pi},${holeIdx},false,${shared})">\u2717 No</button>
    </div>
    <div style="font-size:.54rem;color:var(--tx3);margin-top:6px">Reach in ${hole.par-2} stroke${hole.par-2!==1?'s':''}</div>
  </div>
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
}

function lrSetGir(pi, holeIdx, val, shared) {
const targets = shared ? lrState.players : [lrState.players[pi]];
targets.forEach(p=>{
  const s = p.scores[holeIdx];
  s.gir = s.gir===val ? null : val;
});
lrRenderHole();
}

function lrToggleNote(pi, holeIdx) {
lrState._noteOpen = !lrState._noteOpen;
lrRenderHole();
if(lrState._noteOpen) setTimeout(()=>document.getElementById('lrNoteInput')?.focus(),50);
}

function lrSaveNote(pi, holeIdx, val, shared) {
const targets = shared ? lrState.players : [lrState.players[pi]];
targets.forEach(p=>{ p.scores[holeIdx].notes = val; });
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
lrRenderHole();
}

// \u2500\u2500 Minimize / expand \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrMinimize() {
document.getElementById('lrOverlay').classList.remove('active');
lrUpdatePill();
}

function lrExpand() {
document.getElementById('lrOverlay').classList.add('active');
lrShowScreen('lrHoleScreen');
lrRenderHole();
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
// Floating pill (all tabs)
if(floatPill) {
  floatPill.classList.add('visible');
  document.getElementById('lrFloatTxt').textContent = txt;
  document.getElementById('lrFloatMeta').textContent = meta;
}
// Header pulsing dot
liveDot?.classList.add('visible');
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
}

// \u2500\u2500 End round \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrCancelEndBanner() {
const banner = document.getElementById('lrEndBanner');
if(!banner) return;
// Always reset confirm button back to End Round regardless of how banner was opened
const confirmBtn = banner.querySelector('.btn.danger');
if(confirmBtn) { confirmBtn.textContent = 'End Round'; confirmBtn.onclick = lrConfirmEnd; }
banner.style.display = 'none';
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
renderHandicap();
lrState.saved = true;
const st = document.getElementById('lrSaveStatus');
st.style.color = 'var(--ac)';
st.textContent = '\u2713 Round saved.'+(capped?' Max score (net double bogey) applied to differential.':'');
lrUpdatePill();
}

// \u2500\u2500 PDF export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrExportPdf() {
const players  = lrState.players;
const holes    = lrState.holes;
const hasHcp   = lrHasAnyHandicap();
const mode     = LR_MODES[lrState.mode]?.label || lrState.mode;
const totalPar = holes.reduce((t,h)=>t+h.par,0);

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

const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GORDy Round \u2014 ${escHtml(lrState.courseName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Mono',monospace;background:#f4efe6;color:#2c3a28;padding:20px;max-width:960px;margin:0 auto;font-size:.76rem;}
@media print{body{background:#fff;padding:8px;font-size:.7rem;}.no-print{display:none;}.page-break{page-break-before:always;}}
.hero{background:linear-gradient(135deg,#e8f0e5,#fff);border:2px solid #3d6b35;border-radius:8px;padding:14px 18px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start;}
.hero-title{font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700;color:#2d5127;}
.hero-meta{font-size:.6rem;color:#8a9e82;margin-top:3px;}
.card{background:#fff;border:1px solid #ddd5c4;border-radius:6px;padding:12px 14px;margin-bottom:10px;}
h3{font-size:.54rem;letter-spacing:.16em;text-transform:uppercase;color:#8a9e82;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ddd5c4;}
table{width:100%;border-collapse:collapse;}
td,th{padding:3px 6px;border-bottom:1px solid #f0ebe0;vertical-align:middle;}
th{font-size:.52rem;letter-spacing:.1em;text-transform:uppercase;color:#8a9e82;font-weight:400;border-bottom:2px solid #ddd5c4;}
.print-btn{margin-bottom:12px;padding:5px 14px;background:#3d6b35;color:#fff;border:none;border-radius:4px;font-family:monospace;font-size:.68rem;cursor:pointer;}
.footer{text-align:center;font-size:.5rem;color:#8a9e82;margin-top:16px;letter-spacing:.1em;text-transform:uppercase;}
</style></head><body>
<button class="print-btn no-print" onclick="window.print()">\uD83D\uDDA8 Print / Save PDF</button>
<div class="hero">
<div><div class="hero-title">\u26F3 ${escHtml(lrState.courseName)}</div>
<div class="hero-meta">${escHtml(mode)} \u00B7 ${lrState.date} \u00B7 ${escHtml(lrState.conditions)} \u00B7 ${holes.length} holes</div></div>
<div style="text-align:right;font-size:.62rem;color:#8a9e82">${lrState.tee?lrState.tee+' tees':''}</div>
</div>

${buildTable(false,'Scorecard \u2014 Gross')}

${hasHcp?`<div class="page-break"></div>${buildTable(true,'Scorecard \u2014 Net')}`:''}

<div class="page-break"></div>
<div class="card"><h3>Leaderboard</h3>
<table><thead><tr><th>#</th><th>Player</th><th style="text-align:center">Gross</th><th style="text-align:center">vs Par</th><th style="text-align:center">HCP</th></tr></thead>
<tbody>${leaderboard}</tbody></table></div>

<div class="footer">GORDy the Virtual Caddy \u00B7 Round generated ${new Date().toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'})}</div>
<script>window.onload=()=>window.print();<\/script>
</body></html>`;

const blob = new Blob([html],{type:'text/html'});
const url  = URL.createObjectURL(blob);
const w    = window.open(url,'_blank');
if(w) w.onunload=()=>URL.revokeObjectURL(url);
else  URL.revokeObjectURL(url);
}

// \u2500\u2500 Discard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function lrDiscardRound() {
const banner = document.getElementById('lrEndBanner');
const msg = document.getElementById('lrEndBannerMsg');
if(msg) msg.textContent = 'Discard this round? All scores will be lost.';
// Temporarily rewire confirm button for discard
const confirmBtn = banner?.querySelector('.btn.danger');
if(confirmBtn) { confirmBtn.textContent = 'Discard Round'; confirmBtn.onclick = lrConfirmDiscard; }
if(banner) banner.style.display='block';
}
function lrConfirmDiscard() {
const banner = document.getElementById('lrEndBanner');
if(banner) banner.style.display='none';
// Reset confirm button back to End Round
const confirmBtn = banner?.querySelector('.btn.danger');
if(confirmBtn) { confirmBtn.textContent = 'End Round'; confirmBtn.onclick = lrConfirmEnd; }
lrState = null;
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

// -- Expose to window (required for HTML onclick handlers) --
Object.assign(window, {
  lrStartSetup, lrAddPlayer, lrRemovePlayer, lrToggleMe,
  lrOnCourseSelect, lrOnHoleCountChange, lrOnModeChange,
  lrBeginRound, lrCancelSetup,
  lrTogParPicker, lrSetPar, lrSetView, lrSetNetView, lrGoHole,
  lrMinimize, lrExpand, lrUpdatePill,
  lrShowTally, lrShowTallyFromSummary, lrShowHole,
  lrEndRound, lrCancelEndBanner, lrConfirmEnd,
  lrSaveRound, lrExportPdf,
  lrDiscardRound, lrConfirmDiscard,
  lrAdj, lrSetGir, lrToggleNote, lrSaveNote,
  lrSetPlayer, lrRenderHole, lrRenderTally, lrShowScreen,
});
Object.assign(window, { lrAddPlayer, lrBeginRound, lrCancelEndBanner, lrCancelSetup, lrConfirmEnd, lrDiscardRound, lrEndRound, lrExpand, lrExportPdf, lrGoHole, lrMinimize, lrOnCourseSelect, lrOnHoleCountChange, lrOnModeChange, lrSaveRound, lrSetPar, lrSetView, lrShowHole, lrShowTally, lrShowTallyFromSummary, lrStartSetup, lrTogParPicker });
