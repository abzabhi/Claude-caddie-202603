import { FLIGHT_DATA } from './constants.js';
import { calcHandicap } from './geo.js';

export let bag = [], courses = [], rounds = [], history = [];
export let profile = {};

export function uid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }
export function today() { return new Date().toISOString().slice(0,10); }

export function save() {
  localStorage.setItem('vc:bag', JSON.stringify(bag));
  localStorage.setItem('vc:courses', JSON.stringify(courses));
  localStorage.setItem('vc:rounds', JSON.stringify(rounds));
  localStorage.setItem('vc:history', JSON.stringify(history));
  localStorage.setItem('vc:profile', JSON.stringify(profile));
}

const _SEED = {bag:[], courses:[], history:[]};

export function load() {
  try { const b=JSON.parse(localStorage.getItem('vc:bag')); bag=Array.isArray(b)&&b.length?b.filter(x=>x&&x.id):_SEED.bag; } catch { bag=_SEED.bag; }
  try { const c=JSON.parse(localStorage.getItem('vc:courses')); courses=Array.isArray(c)&&c.length?c.filter(x=>x&&x.id):_SEED.courses; } catch { courses=_SEED.courses; }
  try { const r=JSON.parse(localStorage.getItem('vc:rounds')); rounds=Array.isArray(r)?r:[]; } catch { rounds=[]; }
  try { const h=JSON.parse(localStorage.getItem('vc:history')); history=Array.isArray(h)&&h.length?h.filter(x=>x&&x.id):_SEED.history; } catch { history=_SEED.history; }
  try { const p=JSON.parse(localStorage.getItem('vc:profile')); profile=p&&typeof p==='object'?p:{}; } catch { profile={}; }
  bag=bag.filter(x=>x&&x.id);
  courses=courses.filter(x=>x&&x.id);
  rounds=rounds.filter(x=>x&&x.id);
}

// Mutation helpers -- use at import sites instead of direct binding reassignment
export function setBag(a)      { bag.splice(0, bag.length, ...a); }
export function setRounds(a)   { rounds.splice(0, rounds.length, ...a); }
export function setProfile(p)  { Object.keys(profile).forEach(k=>delete profile[k]); Object.assign(profile, p); }
export function replaceCourse(u) { const i=courses.findIndex(c=>c.id===u.id); if(i>-1) courses[i]=u; }
export function removeCourse(id)  { const i=courses.findIndex(c=>c.id===id);  if(i>-1) courses.splice(i,1); }
export function removeRound(id)   { const i=rounds.findIndex(r=>r.id===id);   if(i>-1) rounds.splice(i,1); }
export function removeHistory(id) { const i=history.findIndex(h=>h.id===id);  if(i>-1) history.splice(i,1); }
export function clearAll() {
  bag.length=0; courses.length=0; rounds.length=0; history.length=0;
  Object.keys(profile).forEach(k=>delete profile[k]);
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
    lines.push('CLUB | '+[c.brand||'',c.type,c.identifier||'',c.stiffness,c.shaftLength||'',opt,c.confidence??4,c.bias||'Straight',c.yardType||'',c.loft||'',c.model||''].join(' | '));
    (c.sessions||[]).forEach(s=>lines.push('  SESSION | '+s.date+' | '+s.min+' | '+s.max+(s.notes?(' | '+s.notes):'')));
  });
  lines.push(''); lines.push('=== COURSES ===');
  lines.push('# id | name | city | par | rating | slope | yardage | selectedTee | updatedAt');
  courses.forEach(c => {
    lines.push('');
    lines.push('COURSE | '+[c.id,c.name||'',c.city||'',c.par||'',c.rating||'',c.slope||'',c.yardage||'',c.selectedTee||'',c.updatedAt||''].join(' | '));
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
    if(r.holes?.length) r.holes.forEach(h=>lines.push('  HOLE | '+[h.n,h.par,h.score,h.putts,h.gir===true?'Y':h.gir===false?'N':'',h.notes||'',h.yards||''].join(' | ')));
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
  lines.push('=== FLIGHT_REF ===');
  lines.push('VERSION | 1');
  lines.push('TIERS | '+FLIGHT_DATA.tiers.join(' | '));
  lines.push('CLUB_KEYS | '+Object.keys(FLIGHT_DATA.clubs).join(' | '));
  lines.push('NOTE | Lateral dispersion is total width in yards. Depth is short/long miss in yards.');
  lines.push('NOTE | Spin RPM and launch angle are mid-amateur benchmarks per handicap tier.');
  lines.push('NOTE | Sources: TrackMan, GOLFTEC, Arccos, DECADE/Practical Golf.');
  lines.push('');
  return lines.join('\n');
}
