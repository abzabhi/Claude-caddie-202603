import { FLIGHT_DATA } from './constants.js';
import { calcHandicap, clubSlug } from './geo.js';

export let bag = [], courses = [], rounds = [], history = [], rangeSessions = [];
export let profile = {};

export function uid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }
export function today() { var n=new Date(),p=function(x){return x<10?'0'+x:''+x;}; return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate()); }

// -- IndexedDB wrapper --------------------------------------------------------
const _IDB_NAME = 'gordy', _IDB_VER = 1, _IDB_STORE = 'state';
let _dbPromise = null;
function _dbOpen() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise(function(resolve, reject) {
    var req = indexedDB.open(_IDB_NAME, _IDB_VER);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) db.createObjectStore(_IDB_STORE);
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
  return _dbPromise;
}
function _idbPut(key, value) {
  return _dbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(_IDB_STORE, 'readwrite');
      var req = tx.objectStore(_IDB_STORE).put(value, key);
      req.onsuccess = resolve; req.onerror = function(e) { reject(e.target.error); };
    });
  });
}
function _idbGet(key) {
  return _dbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(_IDB_STORE, 'readonly');
      var req = tx.objectStore(_IDB_STORE).get(key);
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror   = function(e) { reject(e.target.error); };
    });
  });
}

// -- Persist & load -----------------------------------------------------------
export async function save() {
  await _idbPut('main', {
    profile: Object.assign({}, profile),
    bag: bag.slice(),
    courses: courses.slice(),
    rounds: rounds.slice(),
    history: history.slice(),
    rangeSessions: rangeSessions.slice()
  });
}

const _SEED = {bag:[], courses:[], history:[], rangeSessions:[]};

export async function load() {
  var state = null;
  try { state = await _idbGet('main'); } catch {}
  if (state && typeof state === 'object' && (state.bag || state.courses || state.profile)) {
    // Load from IndexedDB
    var b=state.bag; bag.splice(0,bag.length,...(Array.isArray(b)?b.filter(x=>x&&x.id):[]));
    var c=state.courses; courses.splice(0,courses.length,...(Array.isArray(c)?c.filter(x=>x&&x.id):[]));
    var r=state.rounds; rounds.splice(0,rounds.length,...(Array.isArray(r)?r.filter(x=>x&&x.id):[]));
    var h=state.history; history.splice(0,history.length,...(Array.isArray(h)?h.filter(x=>x&&x.id):[]));
    var rs=state.rangeSessions; rangeSessions.splice(0,rangeSessions.length,...(Array.isArray(rs)?rs.filter(x=>x&&x.sessionId):[]));
    var p=state.profile; Object.keys(profile).forEach(k=>delete profile[k]); if(p&&typeof p==='object') Object.assign(profile,p);
  } else {
    // Migration: read legacy localStorage keys once, then persist to IDB
    try { var lb=JSON.parse(localStorage.getItem('vc:bag')); bag.splice(0,bag.length,...(Array.isArray(lb)&&lb.length?lb.filter(x=>x&&x.id):[])); } catch { bag.splice(0,bag.length); }
    try { var lc=JSON.parse(localStorage.getItem('vc:courses')); courses.splice(0,courses.length,...(Array.isArray(lc)&&lc.length?lc.filter(x=>x&&x.id):[])); } catch { courses.splice(0,courses.length); }
    try { var lr=JSON.parse(localStorage.getItem('vc:rounds')); rounds.splice(0,rounds.length,...(Array.isArray(lr)?lr.filter(x=>x&&x.id):[])); } catch { rounds.splice(0,rounds.length); }
    try { var lh=JSON.parse(localStorage.getItem('vc:history')); history.splice(0,history.length,...(Array.isArray(lh)&&lh.length?lh.filter(x=>x&&x.id):[])); } catch { history.splice(0,history.length); }
    try { var lrs=JSON.parse(localStorage.getItem('vc:rangeSessions')); rangeSessions.splice(0,rangeSessions.length,...(Array.isArray(lrs)?lrs.filter(x=>x&&x.sessionId):[])); } catch { rangeSessions.splice(0,rangeSessions.length); }
    try { var lp=JSON.parse(localStorage.getItem('vc:profile')); Object.keys(profile).forEach(k=>delete profile[k]); if(lp&&typeof lp==='object') Object.assign(profile,lp); } catch {}
    // Clean up legacy keys after migration
    ['vc:bag','vc:courses','vc:rounds','vc:history','vc:rangeSessions','vc:profile'].forEach(k=>localStorage.removeItem(k));
  }
  /* SLUG1c -- delegate to shared reconciler */
  if(reconcileSlugs()) await save();
}

// -- Active round geo (routed directly to IDB) --------------------------------
export async function saveGeo(data) { await _idbPut('activeRoundGeo', data); }
export async function loadGeo() { try { return await _idbGet('activeRoundGeo'); } catch { return null; } }

// -- JSON state snapshot (replaces serialise() for sync/export) ---------------
export async function getJsonState() {
  return {
    profile: Object.assign({}, profile),
    bag: bag.slice(),
    courses: courses.slice(),
    rounds: rounds.slice(),
    history: history.slice(),
    rangeSessions: rangeSessions.slice(),
    hcpMode: localStorage.getItem('vc:hcpMode') || 'calculated',
    manualHcp: localStorage.getItem('vc:manualHcp') || ''
  };
}

/* SLUG1c -- shared slug reconciler. Callable from load() and from any bag-write
   site in ui.js (dbLoadData, _doMergeOverwrite, importData). Does three things:
   (1) regenerates bag slugs to current composite (brand|type|identifier|loft|stiffness);
   (2) builds bagById/bagBySlug/bagByIdent lookup indexes;
   (3) runs cascade reconciler on rangeSessions[].clubSummary[] and rounds[].holes[].shots[],
       matching by clubId, then clubSlug, then unique identifier lookup. Stamps both
       clubId and clubSlug on match. Ambiguous identifier matches are skipped (don't guess).
   Returns true if any value changed (caller can decide whether to persist). */
export function reconcileSlugs() {
  var dirty=false;
  for(var _si=0;_si<bag.length;_si++){
    var _newSlug=clubSlug(bag[_si]);
    if(bag[_si].slug!==_newSlug){ bag[_si].slug=_newSlug; dirty=true; }
  }
  var _bagById={}, _bagBySlug={}, _bagByIdent={};
  for(var _bi=0;_bi<bag.length;_bi++){
    var _bc=bag[_bi]; if(!_bc||!_bc.id) continue;
    _bagById[_bc.id]=_bc;
    if(_bc.slug) _bagBySlug[_bc.slug]=_bc;
    var _ident=String(_bc.identifier==null?'':_bc.identifier).toLowerCase().trim();
    if(_ident){ (_bagByIdent[_ident]=_bagByIdent[_ident]||[]).push(_bc); }
  }
  var _reconcile=function(entry, nameField){
    if(!entry) return null;
    var hit=entry.clubId && _bagById[entry.clubId];
    if(hit) return hit;
    hit=entry.clubSlug && _bagBySlug[entry.clubSlug];
    if(hit) return hit;
    var nm=entry[nameField]; if(nm==null) return null;
    var key=String(nm).toLowerCase().trim(); if(!key) return null;
    var candidates=_bagByIdent[key];
    if(candidates && candidates.length===1) return candidates[0];
    return null;
  };
  for(var _rsi=0;_rsi<rangeSessions.length;_rsi++){
    var _cs=rangeSessions[_rsi] && rangeSessions[_rsi].clubSummary;
    if(!Array.isArray(_cs)) continue;
    for(var _ei=0;_ei<_cs.length;_ei++){
      var _entry=_cs[_ei]; if(!_entry) continue;
      var _match=_reconcile(_entry,'clubName');
      if(_match){
        if(_entry.clubId!==_match.id){ _entry.clubId=_match.id; dirty=true; }
        if(_entry.clubSlug!==_match.slug){ _entry.clubSlug=_match.slug; dirty=true; }
      }
    }
  }
  for(var _ri=0;_ri<rounds.length;_ri++){
    var _holes=rounds[_ri] && rounds[_ri].holes;
    if(!Array.isArray(_holes)) continue;
    for(var _hi=0;_hi<_holes.length;_hi++){
      var _shots=_holes[_hi] && _holes[_hi].shots;
      if(!Array.isArray(_shots)) continue;
      for(var _shi=0;_shi<_shots.length;_shi++){
        var _sh=_shots[_shi]; if(!_sh) continue;
        var _shMatch=_reconcile(_sh,'clubName');
        if(_shMatch){
          if(_sh.clubId!==_shMatch.id){ _sh.clubId=_shMatch.id; dirty=true; }
          if(_sh.clubSlug!==_shMatch.slug){ _sh.clubSlug=_shMatch.slug; dirty=true; }
        }
      }
    }
  }
  return dirty;
}

// Mutation helpers -- use at import sites instead of direct binding reassignment
export function setBag(a)      { bag.splice(0, bag.length, ...a); }
export function setRounds(a)   { rounds.splice(0, rounds.length, ...a); }
export function setProfile(p)  { Object.keys(profile).forEach(k=>delete profile[k]); Object.assign(profile, p); }
export function replaceCourse(u) { const i=courses.findIndex(c=>c.id===u.id); if(i>-1) courses[i]=u; }
export function removeCourse(id)  { const i=courses.findIndex(c=>c.id===id);  if(i>-1) courses.splice(i,1); }
export function removeRound(id)   { const i=rounds.findIndex(r=>r.id===id);   if(i>-1) rounds.splice(i,1); }
export function removeHistory(id) { const i=history.findIndex(h=>h.id===id);  if(i>-1) history.splice(i,1); }
export function removeRangeSession(id) { const i=rangeSessions.findIndex(s=>s.sessionId===id); if(i>-1) rangeSessions.splice(i,1); }
export function clearAll() {
  bag.length=0; courses.length=0; rounds.length=0; history.length=0; rangeSessions.length=0;
  Object.keys(profile).forEach(k=>delete profile[k]);
}

export async function wipeEnvironment() {
  Object.keys(localStorage)
    .filter(k => k.startsWith('vc:') || k.startsWith('gordy:'))
    .forEach(k => localStorage.removeItem(k));
  clearAll();
  _dbPromise = null; // reset cached handle before delete
  await new Promise(function(res) {
    var req = indexedDB.deleteDatabase(_IDB_NAME);
    req.onsuccess = req.onerror = req.onblocked = res;
  });
}

export function serialise() {
  const lines = ['VIRTUAL CADDIE DATA \u2014 v3', 'DataVersion: 3', 'Exported: '+today(), 'FlightDataVersion: 1', ''];
  lines.push('=== PROFILE ===');
  lines.push('NAME | '    +(profile.name||''));
  lines.push('AGE | '     +(profile.age||''));
  lines.push('GENDER | '  +(profile.gender||''));
  lines.push('HANDED | '  +(profile.handed||''));
  lines.push('HOMECLUB | '  +(profile.homeClub||''));
  lines.push('HOMECOURSE | '+(profile.homeCourseId||''));
  lines.push('YARDPREF | '+(profile.yardType||'Total'));
  if(profile.notes) profile.notes.split('\n').forEach(l=>lines.push('NOTE | '+l));
  lines.push('');
  lines.push('=== CLUBS ===');
  bag.forEach(c => {
    const opt = c.type==='Putter'?'PUTTER':c.tested?'YES':'NO';
    lines.push('');
    lines.push('CLUB | '+[c.brand||'',c.type,c.identifier||'',c.stiffness,c.shaftLength||'',opt,c.confidence??4,c.bias||'Straight',c.yardType||'',c.loft||'',c.model||'',c.slug||clubSlug(c)].join(' | ')); /* SLUG1 */
    (c.sessions||[]).forEach(s=>lines.push('  SESSION | '+s.date+' | '+s.min+' | '+s.max+(s.notes?(' | '+s.notes):'')));
  });
  lines.push(''); lines.push('=== COURSES ===');
  lines.push('# id | name | city | par | rating | slope | yardage | selectedTee | updatedAt | osmLon | osmLat | osmCourseId');
  courses.forEach(c => {
    lines.push('');
    lines.push('COURSE | '+[c.id,c.name||'',c.city||'',c.par||'',c.rating||'',c.slope||'',c.yardage||'',c.selectedTee||'',c.updatedAt||'',(c.osmCenter&&c.osmCenter[0])||'',(c.osmCenter&&c.osmCenter[1])||'',c.osmCourseId||''].join(' | ')); /* G2 -- osmCenter + osmCourseId additive */
    (c.tees||[]).forEach(t => {
      lines.push('  TEE | '+[t.id,t.name||'',t.rating||'',t.slope||'',t.yardage||''].join(' | '));
      (t.holes||[]).forEach(h => {
        lines.push('    HOLE | '+[h.number,h.par||'',h.yards||'',h.handicap||'',h.note||''].join(' | '));
      });
    });
  });
  lines.push(''); lines.push('=== ROUNDS ===');
  rounds.forEach(r=>{
    lines.push('ROUND | '+[r.date,r.courseName||'',r.tee||'',r.rating,r.slope,r.par,r.score,r.diff!==null?r.diff:'',r.notes||'',r.countForHandicap===false?'0':'1',r.id||''].join(' | '));
    if(r.sessionIds?.length) lines.push('  SESSIONIDS | '+r.sessionIds.join(','));
    if(r.players?.length) lines.push('  PLAYERS | '+r.players.map(p=>`${p.name||''}:${p.isMe?'1':'0'}:${p.handicap??''}:${p.score??''}`).join(','));
    if(r.holes?.length) r.holes.forEach(h=>{
      lines.push('  HOLE | '+[h.n,h.par,h.score,h.putts,h.gir===true?'Y':h.gir===false?'N':'',h.notes||'',h.yards||'',h.fir===true?'Y':h.fir===false?'N':''].join(' | '));
      if(h.shots?.length) h.shots.forEach(sh=>lines.push('    SHOT | '+JSON.stringify(sh)));
    });
  });
  lines.push('');
  const mode = localStorage.getItem('vc:hcpMode')||'calculated';
  const manualVal = localStorage.getItem('vc:manualHcp')||'';
  const calcVal = calcHandicap(rounds);
  lines.push('=== HANDICAP ===');
  lines.push('MODE | '+mode);
  lines.push('DATE | '+today());
  if(mode==='manual'&&manualVal) lines.push('MANUAL | '+manualVal);
  if(calcVal!==null) lines.push('CALCULATED | '+calcVal+' | from '+rounds.length+' round'+(rounds.length!==1?'s':''));
  lines.push('ACTIVE | '+(mode==='manual'&&manualVal?manualVal:calcVal!==null?calcVal:'not set'));
  lines.push('');
  lines.push('=== HISTORY ===');
  history.forEach(h => {
    lines.push('');
    lines.push('ENTRY | '+[
      h.id, h.date||today(),
      h.type||'result',
      h.course||'',
      h.tee||'',
      h.hcp||'',
      h.playHcp||'',
      h.conditions||'',
      h.holes||''
    ].join(' | '));
    (h.text||'').split('\n').forEach(l => lines.push('  TEXT | '+l));
    if(h.holeMap&&Object.keys(h.holeMap).length){
      const hm=Object.entries(h.holeMap).map(([n,v])=>{
        const paths=(v.paths||[]).map(p=>p.join(',')).join('|');
        return `H${n}|${paths}`;
      }).join(';');
      lines.push('  HOLEMAP | '+hm);
    }
    if(h.bagMap?.length) lines.push('  BAGMAP | '+h.bagMap.join(','));
  });
  lines.push('');
  lines.push('=== RANGE_SESSIONS ===');
  rangeSessions.forEach(s => lines.push('RANGE_SESSION | ' + JSON.stringify(s)));
  lines.push('');
  lines.push('VERSION | 1');
  lines.push('TIERS | '+FLIGHT_DATA.tiers.join(' | '));
  lines.push('CLUB_KEYS | '+Object.keys(FLIGHT_DATA.clubs).join(' | '));
  lines.push('NOTE | Lateral dispersion is total width in yards. Depth is short/long miss in yards.');
  lines.push('NOTE | Spin RPM and launch angle are mid-amateur benchmarks per handicap tier.');
  lines.push('NOTE | Sources: TrackMan, GOLFTEC, Arccos, DECADE/Practical Golf.');
  lines.push('');
  return lines.join('\n');
}
