// src/ui.js
// Tabs, profile, data import/export, dropdown, modals, disclaimer.
// Orchestrates all render functions -- last module loaded.

import { bag, courses, rounds, history, profile, rangeSessions,
         save, today, uid, serialise,
         setBag, setRounds, setProfile, replaceCourse, clearAll, reconcileSlugs } from './store.js'; /* SLUG1c */
import { calcDiff, clubSlug, BUCKET_NAMES, tagLookup, dominantMiss, shotTag } from './geo.js'; /* ASKB-1 */
import { setVizInitDone } from './viz.js';
import { renderClubs } from './clubs.js';
import { renderCourseList } from './courses.js';
import { renderHandicap } from './rounds.js';

// -- Save / Import ------------------------------------------------------------
function saveData() {
  const txt = serialise();
  const blob = new Blob([txt], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'virtual-caddie-data-'+today()+'.txt';
  a.click();
  URL.revokeObjectURL(a.href);
  const st = document.getElementById('saveStatus');
  if(kvMode() && sessionStorage.getItem('vc:kvPass')) {
    syncSave().then(()=>{
      if(st) { st.textContent='\u2713 Saved locally + synced'; st.style.color='var(--ac)'; setTimeout(()=>{st.textContent='';},4000); }
    });
  } else {
    if(st) { st.textContent='\u2713 Saved locally'; st.style.color='var(--tx2)'; setTimeout(()=>{st.textContent='';},3000); }
  }
}
function exportData() { saveData(); }

function processDataText(text) {
  const hasExisting = bag.length || courses.length || rounds.length || history.length;
  if(hasExisting) {
    /* UI-α5 */
    showConfirmModal(
      'Replace Current Data',
      'This will replace your current data. This cannot be undone. Are you sure?',
      function() { _doProcessDataText(text); }
    );
    return;
  }
  _doProcessDataText(text);
}
function _doProcessDataText(text) {
  const lines = text.split('\n');
  const newBag=[], newRounds=[];
  let section=null, cur=null, currentCourse=null, currentTee=null, currentEntry=null;
  const newCourses=[], newHistory=[];
  let newProfile={}, newHcpMode=null, newManualHcp=null, newNoteLines=[];
  const newRangeSessions=[]; /* CLEAN5 -- rangeSessions was silently dropped on legacy TXT import */
  for(const raw of lines) {
    const line=raw.trim();
    if(!line||line.startsWith('#')) continue;
    if(line==='=== PROFILE ===') {section='profile';continue;}
    if(line==='=== CLUBS ==='){section='clubs';continue;}
    if(line==='=== COURSES ==='){section='courses';continue;}
    if(line==='=== ROUNDS ==='){section='rounds';continue;}
    if(line==='=== HANDICAP ==='){section='handicap';continue;}
    if(line==='=== FLIGHT_REF ==='){section='flightref';continue;}
    if(line==='=== HISTORY ==='){section='history';continue;}
    if(line==='=== RANGE_SESSIONS ==='){section='rangeSessions';continue;} /* CLEAN5 */
    if(section==='rangeSessions'&&line.startsWith('RANGE_SESSION | ')){ /* CLEAN5 */
      try { const s=JSON.parse(line.slice('RANGE_SESSION | '.length)); if(s&&s.sessionId) newRangeSessions.push(s); } catch {}
      continue;
    }
    if(section==='profile') {
      const p=line.split('|').map(s=>s.trim());
      if(p[0]==='NAME')        newProfile.name         =p[1]||'';
      else if(p[0]==='AGE')        newProfile.age          =p[1]||'';
      else if(p[0]==='GENDER')     newProfile.gender       =p[1]||'';
      else if(p[0]==='HANDED')     newProfile.handed       =p[1]||'';
      else if(p[0]==='HOMECLUB')   newProfile.homeClub     =p[1]||'';
      else if(p[0]==='HOMECOURSE') newProfile.homeCourseId =p[1]||'';
      else if(p[0]==='YARDPREF')   newProfile.yardType     =p[1]||'';
      else if(p[0]==='NOTE')       newNoteLines.push(p.slice(1).join('|'));
    }
    if(section==='clubs'&&line.startsWith('CLUB |')) {
      const p=line.split('|').map(s=>s.trim());
      cur={id:uid(),brand:p[1]||'',type:p[2]||'Iron',identifier:p[3]||'',stiffness:p[4]||'Regular',shaftLength:p[5]||'',tested:p[6]==='YES'||p[6]==='PUTTER',confidence:p[7]?parseInt(p[7]):4,bias:p[8]||'Straight',yardType:p[9]||'',loft:p[10]||'',model:p[11]||'',sessions:[]};
      cur.slug=p[12]||clubSlug(cur); /* SLUG1 */
      newBag.push(cur);
    } else if(section==='clubs'&&line.startsWith('COMPUTED |')) {
      // pre-computed export values -- skip, app recomputes from raw sessions
    } else if(section==='clubs'&&line.startsWith('SESSION |')&&cur) {
      const p=line.split('|').map(s=>s.trim());
      cur.sessions.push({id:uid(),date:p[1]||today(),min:p[2]||'',max:p[3]||'',notes:p[4]||''});
    }
    if(section==='courses') {
      if(line.startsWith('COURSE |')) {
        const p=line.split('|').map(s=>s.trim());
        currentCourse={id:p[1]||uid(),name:p[2]||'',city:p[3]||'',par:p[4]||'',rating:p[5]||'',slope:p[6]||'',yardage:p[7]||'',selectedTee:p[8]||'',updatedAt:p[9]||'',tees:[],holes:[]};
        newCourses.push(currentCourse);
        currentTee=null;
      } else if(line.startsWith('TEE |')&&currentCourse) {
        const p=line.split('|').map(s=>s.trim());
        currentTee={id:p[1]||uid(),name:p[2]||'',rating:p[3]||'',slope:p[4]||'',yardage:p[5]||'',holes:[]};
        currentCourse.tees.push(currentTee);
      } else if(line.startsWith('HOLE |')&&currentTee) {
        const p=line.split('|').map(s=>s.trim());
        currentTee.holes.push({number:parseInt(p[1])||0,par:p[2]||'',yards:p[3]||'',handicap:p[4]||'',note:p[5]||''});
      }
    }
    if(section==='handicap') {
      const p=line.split('|').map(s=>s.trim());
      if(p[0]==='MODE')   newHcpMode   = p[1]||null;
      if(p[0]==='MANUAL') newManualHcp = p[1]||null;
    }
    if(section==='rounds'&&line.startsWith('ROUND |')) {
      const p=line.split('|').map(s=>s.trim());
      cur={id:p[11]||uid(),date:p[1]||today(),courseName:p[2]||'',tee:p[3]||'',rating:p[4]||'',slope:p[5]||'',par:p[6]||'',score:p[7]||'',diff:p[8]?parseFloat(p[8]):calcDiff(p[7],p[4],p[5]),notes:p[9]||'',countForHandicap:p[10]!=='0',sessionIds:[],holes:[],players:[]};
      newRounds.push(cur);
    } else if(section==='rounds'&&line.startsWith('SESSIONIDS |')&&cur) {
      cur.sessionIds=line.replace(/^SESSIONIDS \| /,'').trim().split(',').filter(Boolean);
    } else if(section==='rounds'&&line.startsWith('PLAYERS |')&&cur) {
      cur.players=line.replace(/^PLAYERS \| /,'').trim().split(',').map(s=>{const[n,me,hcp,sc]=s.split(':');return{name:n||'',isMe:me==='1',handicap:hcp?+hcp:null,score:sc?+sc:null};});
    } else if(section==='rounds'&&line.startsWith('HOLE |')&&cur) {
      const p=line.split('|').map(s=>s.trim());
      cur.holes.push({n:parseInt(p[1])||0,par:p[2]||'',score:p[3]||'',putts:p[4]||'',gir:p[5]==='Y'?true:p[5]==='N'?false:null,notes:p[6]||'',yards:p[7]||'',fir:p[8]==='Y'?true:p[8]==='N'?false:null,shots:[]});
    } else if(section==='rounds'&&line.startsWith('SHOT |')&&cur&&cur.holes.length) {
      try { cur.holes[cur.holes.length-1].shots.push(JSON.parse(line.slice(7))); } catch {}
    }
    if(section==='history') {
      if(raw.trimStart().startsWith('ENTRY |')) {
        const p=raw.trim().split('|').map(s=>s.trim());
        currentEntry={id:p[1]||uid(),date:p[2]||today(),type:p[3]||'result',course:p[4]||'',tee:p[5]||'',hcp:p[6]||'',playHcp:p[7]||'',conditions:p[8]||'',holes:p[9]||'',text:''};
        newHistory.push(currentEntry);
      } else if(raw.trimStart().startsWith('TEXT |')&&currentEntry) {
        const txt=raw.replace(/^\s*TEXT \| /,'');
        currentEntry.text = currentEntry.text ? currentEntry.text+'\n'+txt : txt;
      } else if(raw.trimStart().startsWith('HOLEMAP |')&&currentEntry) {
        const hm=raw.replace(/^\s*HOLEMAP \| /,'').trim();
        currentEntry.holeMap={};
        hm.split(';').forEach(tok=>{
          if(tok.includes('|')){
            const[hn,...pathParts]=tok.split('|');
            const n=parseInt(hn.replace('H',''));
            if(n) currentEntry.holeMap[n]={paths:pathParts.map(p=>p.split(',').filter(Boolean))};
          } else {
            const[hn,tee,layup,app]=tok.split(':');
            if(hn){const n=parseInt(hn.replace('H',''));const paths=[[tee,layup,app].filter(Boolean)];if(n)currentEntry.holeMap[n]={paths};}
          }
        });
      } else if(raw.trimStart().startsWith('BAGMAP |')&&currentEntry) {
        currentEntry.bagMap=raw.replace(/^\s*BAGMAP \| /,'').trim().split(',').filter(Boolean);
      }
    }
  }
  if(newBag.length) setBag(newBag);
  if(newRounds.length) setRounds(newRounds);
  if(Object.keys(newProfile).length) {
    if(newNoteLines.length) newProfile.notes = newNoteLines.join('\n');
    setProfile(newProfile);
  }
  if(newHcpMode) localStorage.setItem('vc:hcpMode', newHcpMode);
  if(newManualHcp) localStorage.setItem('vc:manualHcp', newManualHcp);
  if(newCourses.length) {
    newCourses.forEach(ic => {
      const selTee = ic.tees.find(t=>t.id===ic.selectedTee);
      if(selTee) ic.holes = selTee.holes;
      const existing = courses.find(c=>c.id===ic.id);
      if(!existing) {
        courses.push(ic);
      } else if(!existing.updatedAt || (ic.updatedAt && ic.updatedAt >= existing.updatedAt)) {
        replaceCourse(ic);
      }
    });
  }
  if(newHistory.length) {
    const existingIds = new Set(history.map(h=>h.id));
    newHistory.forEach(h=>{ if(!existingIds.has(h.id)) history.unshift(h); });
  }
  /* CLEAN5 -- restore rangeSessions on legacy TXT import (was silently dropped) */
  if(newRangeSessions.length){const ids=new Set(rangeSessions.map(s=>s.sessionId)); newRangeSessions.forEach(s=>{if(!ids.has(s.sessionId)) rangeSessions.push(s);});}
  document.getElementById('uploadBanner').style.display='none';
  reconcileSlugs(); /* SLUG1c -- reconcile after bag/rounds/sessions written */
  save(); renderAll();
  alert('Data imported successfully.');
}

// -- Shared parser (processDataText + mergeDataText) --------------------------
function _parseDataText(text) {
  const lines=text.split('\n');
  const newBag=[], newRounds=[], newCourses=[], newHistory=[], newRangeSessions=[];
  let section=null, cur=null, currentCourse=null, currentTee=null, currentEntry=null;
  let newProfile={}, newHcpMode=null, newManualHcp=null, newNoteLines=[];
  for(const raw of lines) {
    const line=raw.trim();
    if(!line||line.startsWith('#')) continue;
    if(line==='=== PROFILE ==='){section='profile';continue;}
    if(line==='=== CLUBS ==='){section='clubs';continue;}
    if(line==='=== COURSES ==='){section='courses';continue;}
    if(line==='=== ROUNDS ==='){section='rounds';continue;}
    if(line==='=== HANDICAP ==='){section='handicap';continue;}
    if(line==='=== FLIGHT_REF ==='){section='flightref';continue;}
    if(line==='=== HISTORY ==='){section='history';continue;}
    if(line==='=== RANGE_SESSIONS ==='){section='rangeSessions';continue;}
    if(section==='rangeSessions'&&line.startsWith('RANGE_SESSION | ')){
      try { const s=JSON.parse(line.slice('RANGE_SESSION | '.length)); if(s&&s.sessionId) newRangeSessions.push(s); } catch {}
      continue;
    }
    if(section==='profile'){
      const p=line.split('|').map(s=>s.trim());
      if(p[0]==='NAME')        newProfile.name         =p[1]||'';
      else if(p[0]==='AGE')        newProfile.age          =p[1]||'';
      else if(p[0]==='GENDER')     newProfile.gender       =p[1]||'';
      else if(p[0]==='HANDED')     newProfile.handed       =p[1]||'';
      else if(p[0]==='HOMECLUB')   newProfile.homeClub     =p[1]||'';
      else if(p[0]==='HOMECOURSE') newProfile.homeCourseId =p[1]||'';
      else if(p[0]==='YARDPREF')   newProfile.yardType     =p[1]||'';
      else if(p[0]==='NOTE')       newNoteLines.push(p.slice(1).join('|'));
    }
    if(section==='clubs'&&line.startsWith('CLUB |')){
      const p=line.split('|').map(s=>s.trim());
      cur={id:uid(),brand:p[1]||'',type:p[2]||'Iron',identifier:p[3]||'',stiffness:p[4]||'Regular',shaftLength:p[5]||'',tested:p[6]==='YES'||p[6]==='PUTTER',confidence:p[7]?parseInt(p[7]):4,bias:p[8]||'Straight',yardType:p[9]||'',loft:p[10]||'',model:p[11]||'',sessions:[]};
      cur.slug=p[12]||clubSlug(cur); /* SLUG1 */
      newBag.push(cur);
    } else if(section==='clubs'&&line.startsWith('SESSION |')&&cur){
      const p=line.split('|').map(s=>s.trim());
      cur.sessions.push({id:uid(),date:p[1]||today(),min:p[2]||'',max:p[3]||'',notes:p[4]||''});
    }
    if(section==='courses'){
      if(line.startsWith('COURSE |')){
        const p=line.split('|').map(s=>s.trim());
        currentCourse={id:p[1]||uid(),name:p[2]||'',city:p[3]||'',par:p[4]||'',rating:p[5]||'',slope:p[6]||'',yardage:p[7]||'',selectedTee:p[8]||'',updatedAt:p[9]||'',tees:[],holes:[]};
        newCourses.push(currentCourse); currentTee=null;
      } else if(line.startsWith('TEE |')&&currentCourse){
        const p=line.split('|').map(s=>s.trim());
        currentTee={id:p[1]||uid(),name:p[2]||'',rating:p[3]||'',slope:p[4]||'',yardage:p[5]||'',holes:[]};
        currentCourse.tees.push(currentTee);
      } else if(line.startsWith('HOLE |')&&currentTee){
        const p=line.split('|').map(s=>s.trim());
        currentTee.holes.push({number:parseInt(p[1])||0,par:p[2]||'',yards:p[3]||'',handicap:p[4]||'',note:p[5]||''});
      }
    }
    if(section==='handicap'){
      const p=line.split('|').map(s=>s.trim());
      if(p[0]==='MODE')   newHcpMode  =p[1]||null;
      if(p[0]==='MANUAL') newManualHcp=p[1]||null;
    }
    if(section==='rounds'&&line.startsWith('ROUND |')){
      const p=line.split('|').map(s=>s.trim());
      cur={id:p[11]||uid(),date:p[1]||today(),courseName:p[2]||'',tee:p[3]||'',rating:p[4]||'',slope:p[5]||'',par:p[6]||'',score:p[7]||'',diff:p[8]?parseFloat(p[8]):calcDiff(p[7],p[4],p[5]),notes:p[9]||'',countForHandicap:p[10]!=='0',sessionIds:[],holes:[],players:[]};
      newRounds.push(cur);
    } else if(section==='rounds'&&line.startsWith('SESSIONIDS |')&&cur){
      cur.sessionIds=line.replace(/^SESSIONIDS \| /,'').trim().split(',').filter(Boolean);
    } else if(section==='rounds'&&line.startsWith('PLAYERS |')&&cur){
      cur.players=line.replace(/^PLAYERS \| /,'').trim().split(',').map(s=>{const[n,me,hcp,sc]=s.split(':');return{name:n||'',isMe:me==='1',handicap:hcp?+hcp:null,score:sc?+sc:null};});
    } else if(section==='rounds'&&line.startsWith('HOLE |')&&cur){
      const p=line.split('|').map(s=>s.trim());
      cur.holes.push({n:parseInt(p[1])||0,par:p[2]||'',score:p[3]||'',putts:p[4]||'',gir:p[5]==='Y'?true:p[5]==='N'?false:null,notes:p[6]||'',yards:p[7]||'',fir:p[8]==='Y'?true:p[8]==='N'?false:null,shots:[]});
    } else if(section==='rounds'&&line.startsWith('SHOT |')&&cur&&cur.holes.length){
      try { cur.holes[cur.holes.length-1].shots.push(JSON.parse(line.slice(7))); } catch {}
    }
    if(section==='history'){
      if(raw.trimStart().startsWith('ENTRY |')){
        const p=raw.trim().split('|').map(s=>s.trim());
        currentEntry={id:p[1]||uid(),date:p[2]||today(),type:p[3]||'result',course:p[4]||'',tee:p[5]||'',hcp:p[6]||'',playHcp:p[7]||'',conditions:p[8]||'',holes:p[9]||'',text:''};
        newHistory.push(currentEntry);
      } else if(raw.trimStart().startsWith('TEXT |')&&currentEntry){
        const txt=raw.replace(/^\s*TEXT \| /,'');
        currentEntry.text=currentEntry.text?currentEntry.text+'\n'+txt:txt;
      } else if(raw.trimStart().startsWith('HOLEMAP |')&&currentEntry){
        const hm=raw.replace(/^\s*HOLEMAP \| /,'').trim();
        currentEntry.holeMap={};
        hm.split(';').forEach(tok=>{
          if(tok.includes('|')){
            const[hn,...pathParts]=tok.split('|');
            const n=parseInt(hn.replace('H',''));
            if(n) currentEntry.holeMap[n]={paths:pathParts.map(p=>p.split(',').filter(Boolean))};
          } else {
            const[hn,tee,layup,app]=tok.split(':');
            if(hn){const n=parseInt(hn.replace('H',''));const paths=[[tee,layup,app].filter(Boolean)];if(n)currentEntry.holeMap[n]={paths};}
          }
        });
      } else if(raw.trimStart().startsWith('BAGMAP |')&&currentEntry){
        currentEntry.bagMap=raw.replace(/^\s*BAGMAP \| /,'').trim().split(',').filter(Boolean);
      }
    }
  }
  return {newBag,newRounds,newCourses,newHistory,newRangeSessions,newProfile,newHcpMode,newManualHcp,newNoteLines};
}

// After sync replaces bag, remap club references to the new bag's ids
// by matching on stable slug (preferred) or legacy composite key.
// Scope: gordy:activeRange, gordy:activeRound, saved rounds[] shot records.
// Missing matches left as-is (fallback paths tolerate better than silent swap).
/* SLUG2 -- renamed from _remapActiveRangeClubIds; extended scope */
function _remapClubRefs(oldBag, newBag) {
  function kLegacy(c){ return (c.brand||'')+'|'+(c.type||'')+'|'+(c.identifier||'')+'|'+(c.loft||'')+'|'+(c.model||''); }
  var oldById = {};
  for (var a=0; a<oldBag.length; a++) { if (oldBag[a] && oldBag[a].id) oldById[oldBag[a].id] = oldBag[a]; }
  var newBySlug = {}, newByLegacy = {};
  for (var b=0; b<newBag.length; b++) {
    var nb = newBag[b]; if (!nb || !nb.id) continue;
    if (nb.slug) newBySlug[nb.slug] = nb.id;
    newByLegacy[kLegacy(nb)] = nb.id;
  }

  function remap(id){
    if (!id) return id;
    var oc = oldById[id];
    if (!oc) return id;
    // Slug-first: if old club had a slug, match by slug on new bag
    if (oc.slug && newBySlug[oc.slug]) return newBySlug[oc.slug];
    // Fallback: legacy composite key
    var nid = newByLegacy[kLegacy(oc)];
    return nid || id;
  }

  // -------- gordy:activeRange --------
  var rawR = localStorage.getItem('gordy:activeRange');
  if (rawR) {
    var blobR; try { blobR = JSON.parse(rawR); } catch(e) { blobR = null; }
    if (blobR && typeof blobR === 'object') {
      var changedR = false;
      var rr = remap(blobR.clubId);
      if (rr !== blobR.clubId) { blobR.clubId = rr; changedR = true; }
      if (Array.isArray(blobR.club_bag_snapshot)) {
        for (var i=0; i<blobR.club_bag_snapshot.length; i++) {
          var nr = remap(blobR.club_bag_snapshot[i]);
          if (nr !== blobR.club_bag_snapshot[i]) { blobR.club_bag_snapshot[i] = nr; changedR = true; }
        }
      }
      if (Array.isArray(blobR.shots)) {
        for (var j=0; j<blobR.shots.length; j++) {
          var sh = blobR.shots[j]; if (!sh) continue;
          var nr2 = remap(sh.clubId);
          if (nr2 !== sh.clubId) { sh.clubId = nr2; changedR = true; }
        }
      }
      if (changedR) { try { localStorage.setItem('gordy:activeRange', JSON.stringify(blobR)); } catch(e) {} }
    }
  }

  // -------- gordy:activeRound --------
  var rawAR = localStorage.getItem('gordy:activeRound');
  if (rawAR) {
    var blobAR; try { blobAR = JSON.parse(rawAR); } catch(e) { blobAR = null; }
    if (blobAR && Array.isArray(blobAR.players)) {
      var changedAR = false;
      for (var pi=0; pi<blobAR.players.length; pi++) {
        var scores = blobAR.players[pi] && blobAR.players[pi].scores;
        if (!Array.isArray(scores)) continue;
        for (var si=0; si<scores.length; si++) {
          var sc = scores[si]; if (!sc || !Array.isArray(sc.shots)) continue;
          for (var shi=0; shi<sc.shots.length; shi++) {
            var shot = sc.shots[shi]; if (!shot) continue;
            var nr3 = remap(shot.clubId);
            if (nr3 !== shot.clubId) { shot.clubId = nr3; changedAR = true; }
          }
        }
      }
      if (changedAR) { try { localStorage.setItem('gordy:activeRound', JSON.stringify(blobAR)); } catch(e) {} }
    }
  }

  // -------- saved rounds[] --------
  // Mutates in place; caller (dbLoadData) calls save() afterwards.
  for (var ri=0; ri<rounds.length; ri++) {
    var rd = rounds[ri]; if (!rd || !Array.isArray(rd.holes)) continue;
    for (var hi=0; hi<rd.holes.length; hi++) {
      var hole = rd.holes[hi]; if (!hole || !Array.isArray(hole.shots)) continue;
      for (var shi2=0; shi2<hole.shots.length; shi2++) {
        var sh2 = hole.shots[shi2]; if (!sh2) continue;
        var nr4 = remap(sh2.clubId);
        if (nr4 !== sh2.clubId) sh2.clubId = nr4;
      }
    }
  }
}

/* SLUG2 -- legacy name preserved as alias; callers may still reference it */
function _remapActiveRangeClubIds(oldBag, newBag) { return _remapClubRefs(oldBag, newBag); }

// Silent sync loader -- called by dbPull on login/refresh. No confirm, no alert, no renderAll.
// renderAll is called by gateUnlocked() after this returns.
function dbLoadData(text) {
  const {newBag,newRounds,newCourses,newHistory,newRangeSessions,newProfile,newHcpMode,newManualHcp,newNoteLines}=_parseDataText(text);
  if(newBag.length) { var _oldBag = bag.slice(); setBag(newBag); _remapClubRefs(_oldBag, bag); } /* SLUG2 */
  if(newRounds.length) setRounds(newRounds);
  if(Object.keys(newProfile).length){if(newNoteLines.length) newProfile.notes=newNoteLines.join('\n'); setProfile(newProfile);}
  if(newHcpMode) localStorage.setItem('vc:hcpMode',newHcpMode);
  if(newManualHcp) localStorage.setItem('vc:manualHcp',newManualHcp);
  if(newCourses.length){
    newCourses.forEach(ic=>{
      const selTee=ic.tees.find(t=>t.id===ic.selectedTee); if(selTee) ic.holes=selTee.holes;
      const existing=courses.find(c=>c.id===ic.id);
      if(!existing) courses.push(ic);
      else if(!existing.updatedAt||(ic.updatedAt&&ic.updatedAt>=existing.updatedAt)) replaceCourse(ic);
    });
  }
  if(newHistory.length){const ids=new Set(history.map(h=>h.id)); newHistory.forEach(h=>{if(!ids.has(h.id)) history.unshift(h);});}
  if(newRangeSessions.length){const ids=new Set(rangeSessions.map(s=>s.sessionId)); newRangeSessions.forEach(s=>{if(!ids.has(s.sessionId)) rangeSessions.push(s);});}
  reconcileSlugs(); /* SLUG1c -- reconcile after sync pull rebuilds bag from blob */
  save();
}

function _doMergeOverwrite(newBag,newRounds,newCourses,newHistory,newProfile,newHcpMode,newManualHcp,newNoteLines) {
  if(newBag.length) setBag(newBag);
  if(newRounds.length) setRounds(newRounds);
  if(Object.keys(newProfile).length){if(newNoteLines.length) newProfile.notes=newNoteLines.join('\n'); setProfile(newProfile);}
  if(newHcpMode) localStorage.setItem('vc:hcpMode',newHcpMode);
  if(newManualHcp) localStorage.setItem('vc:manualHcp',newManualHcp);
  if(newCourses.length){
    newCourses.forEach(ic=>{
      const selTee=ic.tees.find(t=>t.id===ic.selectedTee); if(selTee) ic.holes=selTee.holes;
      const existing=courses.find(c=>c.id===ic.id);
      if(!existing) courses.push(ic);
      else if(!existing.updatedAt||(ic.updatedAt&&ic.updatedAt>=existing.updatedAt)) { replaceCourse(ic); }
    });
  }
  if(newHistory.length){const ids=new Set(history.map(h=>h.id)); newHistory.forEach(h=>{if(!ids.has(h.id)) history.unshift(h);});}
  document.getElementById('uploadBanner').style.display='none';
  reconcileSlugs(); /* SLUG1c -- reconcile after overwrite rebuilds bag */
  save(); renderAll(); alert('Data overwritten successfully.');
}

// mode: 'append' | 'merge' | 'overwrite'
function mergeDataText(text, mode) {
  const {newBag,newRounds,newCourses,newHistory,newProfile,newHcpMode,newManualHcp,newNoteLines}=_parseDataText(text);

  if(mode==='overwrite') {
    const hasExisting=bag.length||courses.length||rounds.length||history.length;
    /* UI-α6 */
    if(hasExisting) {
      showConfirmModal(
        'Overwrite All Data',
        'OVERWRITE will replace ALL your current data. This cannot be undone. Are you sure?',
        function() { _doMergeOverwrite(newBag,newRounds,newCourses,newHistory,newProfile,newHcpMode,newManualHcp,newNoteLines); }
      );
      return;
    }
    _doMergeOverwrite(newBag,newRounds,newCourses,newHistory,newProfile,newHcpMode,newManualHcp,newNoteLines);
    return;
  }

  if(mode==='append') {
    const roundIds=new Set(rounds.map(r=>r.id));
    const toAdd=newRounds.filter(r=>!roundIds.has(r.id));
    const histIds=new Set(history.map(h=>h.id));
    const histToAdd=newHistory.filter(h=>!histIds.has(h.id));
    if(!toAdd.length&&!histToAdd.length){
      alert('Append: nothing new to add \u2014 all rounds and sessions already present.'); return;
    }
    /* UI-α7 */
    showConfirmModal(
      'Append Data',
      'Append will add ' + toAdd.length + ' new round(s) and ' + histToAdd.length + ' new session(s). No existing data will be changed. Continue?',
      function() {
        rounds.push(...toAdd);
        histToAdd.forEach(h=>history.unshift(h));
        reconcileSlugs(); /* SLUG1c -- reconcile after append adds rounds */
        save(); renderAll();
        alert('Appended: '+toAdd.length+' round(s), '+histToAdd.length+' session(s).');
      },
      false
    );
    return;
  }

  if(mode==='merge') {
    const clubConflicts=[];
    let roundsAdded=0, histAdded=0, coursesAdded=0, coursesUpdated=0;
    const roundIds=new Set(rounds.map(r=>r.id));
    newRounds.filter(r=>!roundIds.has(r.id)).forEach(r=>{rounds.push(r); roundsAdded++;});
    const histIds=new Set(history.map(h=>h.id));
    newHistory.forEach(h=>{if(!histIds.has(h.id)){history.unshift(h); histAdded++;}});
    newCourses.forEach(ic=>{
      const selTee=ic.tees.find(t=>t.id===ic.selectedTee); if(selTee) ic.holes=selTee.holes;
      const existing=courses.find(c=>c.id===ic.id);
      if(!existing){courses.push(ic); coursesAdded++;}
      else if(!existing.updatedAt||(ic.updatedAt&&ic.updatedAt>existing.updatedAt)){
        replaceCourse(ic); coursesUpdated++;
      }
    });
    newBag.forEach(inc=>{
      const match=bag.find(b=>b.type===inc.type&&b.identifier===inc.identifier);
      if(!match) bag.push(inc);
      else clubConflicts.push(`${inc.type}${inc.identifier?' ('+inc.identifier+')':''}`);
    });
    let msg=`Merge summary:\n\u2022 ${roundsAdded} round(s) added\n\u2022 ${histAdded} session(s) added\n\u2022 ${coursesAdded} course(s) added, ${coursesUpdated} updated`;
    if(clubConflicts.length) msg+=`\n\u2022 ${clubConflicts.length} club(s) skipped (conflict \u2014 existing kept):\n  ${clubConflicts.join(', ')}`;
    /* UI-α8 */
    showConfirmModal(
      'Save Merge',
      msg + '\n\nSave and apply?',
      function() { reconcileSlugs(); save(); renderAll(); alert('Merge saved.'); } /* SLUG1c */
    );
    return;
  }
}

function importData(e) {
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => processDataText(ev.target.result);
  reader.readAsText(file); e.target.value='';
}

function onMergeFile(e, mode) {
  const file=e.target.files[0]; e.target.value=''; if(!file) return;
  const st=document.getElementById('mergeStatus');
  if(st) st.textContent='Reading file\u2026';
  const reader=new FileReader();
  reader.onload=ev=>{ if(st) st.textContent=''; mergeDataText(ev.target.result, mode); };
  reader.readAsText(file);
}

// -- Tabs ---------------------------------------------------------------------
function showTab(id) {
  try{ localStorage.setItem('gordy:lastTab',id); }catch(e){}
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  if(event&&event.currentTarget) event.currentTarget.classList.add('active');
  if(id==='profile')  renderProfile();
  if(id==='clubs')    renderClubs();
  if(id==='courses')  renderCourseList();
  if(id==='rounds')   { renderHandicap(); if(window.updateSessionLinker) window.updateSessionLinker(); }
  if(id==='gordy')    window.renderAIHelp();
  if(id==='sessions') window.renderSessions();
  if(id==='viz')      window.initViz();
}

// -- Profile ------------------------------------------------------------------
function saveProfile() {
  setProfile({
    name:         document.getElementById('pfName')?.value||'',
    age:          document.getElementById('pfAge')?.value||'',
    gender:       document.getElementById('pfGender')?.value||'',
    handed:       document.getElementById('pfHanded')?.value||'',
    homeClub:     document.getElementById('pfHomeClub')?.value||'',
    homeCourseId: profile.homeCourseId||'',
    notes:        document.getElementById('pfNotes')?.value||'',
    yardType:     document.getElementById('pfYardType')?.value||'Total'
  });
  save();
  renderProfileHero();
}

function renderProfileHero() {
  const name = profile.name||'Golfer';
  const initials = name.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'\u26F3';
  const hcp = getHandicap();
  const el = id => document.getElementById(id);
  if(el('profileAvatar')) el('profileAvatar').textContent = initials.length?initials:'\u26F3';
  if(el('profileNameDisplay')) el('profileNameDisplay').textContent = 'Welcome, '+name;
  if(el('profileHcpNum')) el('profileHcpNum').textContent = hcp!==null?hcp:'\u2014';
  const homeLabel = profile.homeCourseId
    ? (courses.find(c=>c.id===profile.homeCourseId)?.name || profile.homeClub)
    : profile.homeClub;
  const tags = [profile.handed, homeLabel].filter(Boolean);
  if(el('profileTagline')) el('profileTagline').textContent = tags.length?tags.join(' \u00B7 '):'Gordy the Virtual Caddy';
  if(el('hdrAvatarInitials')) el('hdrAvatarInitials').textContent = initials;
}

function renderProfile() {
  const el = id => document.getElementById(id);
  if(el('pfName'))     el('pfName').value     = profile.name||'';
  if(el('pfAge'))      el('pfAge').value      = profile.age||'';
  if(el('pfGender'))   el('pfGender').value   = profile.gender||'';
  if(el('pfHanded'))   el('pfHanded').value   = profile.handed||'';
  const sel = el('pfHomeClubSelect');
  if(sel) {
    sel.innerHTML = '<option value="">\u2014 Select from your courses \u2014</option>'
      + courses.map(c=>`<option value="${c.id}">${c.name}${c.city?' \u00B7 '+c.city:''}</option>`).join('');
    sel.value = profile.homeCourseId && courses.find(c=>c.id===profile.homeCourseId) ? profile.homeCourseId : '';
  }
  if(el('pfNotes'))    el('pfNotes').value    = profile.notes||'';
  if(el('pfYardType')) el('pfYardType').value = profile.yardType||'Total';
  renderProfileHero();
  // Stats
  const active = bag.filter(c=>c.type!=='Putter'&&c.tested);
  const totalClubSessions = bag.reduce((n,c)=>(n+(c.sessions||[]).length),0);
  if(el('statActiveClubs'))   el('statActiveClubs').textContent   = active.length;
  if(el('statRounds'))        el('statRounds').textContent        = rounds.length;
  if(el('statCourses'))       el('statCourses').textContent       = courses.length;
  if(el('statSessions'))      el('statSessions').textContent      = history.length;
  if(el('statClubSessions'))  el('statClubSessions').textContent  = totalClubSessions;
  if(el('statRangeSessions')) el('statRangeSessions').textContent = rangeSessions.length;
  // Club type breakdown
  const breakdown = el('clubTypeBreakdown');
  if(breakdown) {
    const order = ['Driver','Fairway Wood','Hybrid','Iron','Wedge','Putter','Chipper'];
    const groups = {};
    bag.filter(c=>c.tested||c.type==='Putter').forEach(c=>{
      if(!groups[c.type]) groups[c.type]=[];
      groups[c.type].push(c.identifier||c.brand||c.type);
    });
    const keys = order.filter(k=>groups[k]);
    if(!keys.length) {
      breakdown.innerHTML='<div style="font-size:.68rem;color:var(--tx3)">No active clubs yet \u2014 add clubs in the Clubs tab.</div>';
    } else {
      breakdown.innerHTML = keys.map(k=>`
        <div class="club-type-group">
          <span class="club-type-name">${k}</span>
          <span class="club-type-names">${groups[k].join(', ')}</span>
          <span class="club-type-count">${groups[k].length}</span>
        </div>`).join('');
    }
  }
  renderPerfSummary();
  window.renderGistSettings();
}

function renderPerfSummary() {
  var body = document.getElementById('perf-summary-body');
  if (!body) return;

  var firHit=0,firElig=0,girHit=0,girElig=0;
  var puttTotal=0,puttRounds=0,totalPuttHoles=0;
  var onePuttCount=0,threePuttCount=0;
  var puttsOnGIR=0,puttsOnGIRCount=0;
  var scrambleHit=0,scrambleElig=0;
  var birdiesOrBetter=0,bogeysOrWorse=0;
  var parGroups={3:{s:0,n:0},4:{s:0,n:0},5:{s:0,n:0}};
  var sgTotals={total:0,ott:0,app:0,arg:0,putt:0};
  var sgRounds=0;
  var hasSGFn=!!window._lrRoundSG;

  rounds.forEach(function(r){
    if(!r.holes||!r.holes.length) return;
    var rPutts=0,rHasPutts=false;
    r.holes.forEach(function(h){
      if(h.fir!==null&&h.fir!==undefined){firElig++;if(h.fir===true)firHit++;}
      if(h.gir!==null&&h.gir!==undefined){girElig++;if(h.gir===true)girHit++;}
      if(h.putts!==null&&h.putts!==undefined){
        var pt=+h.putts;
        rPutts+=pt;rHasPutts=true;totalPuttHoles++;
        if(pt===1)onePuttCount++;
        if(pt>=3)threePuttCount++;
        if(h.gir===true){puttsOnGIR+=pt;puttsOnGIRCount++;}
      }
      var par=parseInt(h.par)||0;
      var sc=(h.score!==null&&h.score!==undefined)?+h.score:null;
      if(par>=3&&par<=5&&sc!==null){
        parGroups[par].s+=(sc-par);parGroups[par].n++;
        var d=sc-par;
        if(d<=-1)birdiesOrBetter++;
        if(d>=1)bogeysOrWorse++;
      }
      if(h.gir===false&&sc!==null&&par>=3){
        scrambleElig++;
        if(sc<=par)scrambleHit++;
      }
    });
    if(rHasPutts){puttTotal+=rPutts;puttRounds++;}
    if(hasSGFn){
      var sg=window._lrRoundSG(r.holes,r.holes);
      if(sg&&sg.total!==null&&sg.total!==undefined){
        sgTotals.total+=sg.total||0;sgTotals.ott+=sg.OTT||0;
        sgTotals.app+=sg.APP||0;sgTotals.arg+=sg.ARG||0;
        sgTotals.putt+=sg.PUTT||0;sgRounds++;
      }
    }
  });

  var clubMap={}, clubDispMap={};
  rangeSessions.forEach(function(s){
    if(!s.clubSummary) return;
    s.clubSummary.forEach(function(entry){
      /* SLUG2 -- slug-first key; clubId fallback for legacy entries */
      var cid=entry.clubSlug||entry.clubId;
      var count=(entry.targets||[]).reduce(function(n,t){return n+(t.shotCount||0);},0);
      clubMap[cid]=(clubMap[cid]||0)+count;
      if(!clubDispMap[cid]) clubDispMap[cid]={bull:0,inner:[0,0,0,0,0,0,0,0],outer:[0,0,0,0,0,0,0,0],fp:{str:0,ltr:0,rtl:0}};
      var d=clubDispMap[cid];
      (entry.targets||[]).forEach(function(t){
        if(!t.dispersion) return;
        var dp=t.dispersion;
        d.bull+=dp.bull.total||0;
        d.fp.str+=dp.bull.flightPaths.straight||0;
        d.fp.ltr+=dp.bull.flightPaths['left-to-right']||0;
        d.fp.rtl+=dp.bull.flightPaths['right-to-left']||0;
        for(var i=0;i<8;i++){
          if(dp.inner[i]){d.inner[i]+=dp.inner[i].total||0;d.fp.str+=dp.inner[i].flightPaths.straight||0;d.fp.ltr+=dp.inner[i].flightPaths['left-to-right']||0;d.fp.rtl+=dp.inner[i].flightPaths['right-to-left']||0;}
          if(dp.outer[i]){d.outer[i]+=dp.outer[i].total||0;d.fp.str+=dp.outer[i].flightPaths.straight||0;d.fp.ltr+=dp.outer[i].flightPaths['left-to-right']||0;d.fp.rtl+=dp.outer[i].flightPaths['right-to-left']||0;}
        }
      });
    });
  });
  var clubEntries=Object.keys(clubMap).map(function(cid){
    /* SLUG2 -- slug lookup first, then legacy id lookup */
    var c=bag.find(function(x){return x.slug===cid;})||bag.find(function(x){return x.id===cid;});
    var storedName=rangeSessions.reduce(function(n,s){if(n)return n;var e=s.clubSummary&&s.clubSummary.find(function(x){return (x.clubSlug||x.clubId)===cid;});return e?e.clubName:null;},null);
    return {name:c?(c.identifier||c.type):storedName||cid,count:clubMap[cid],disp:clubDispMap[cid]||null};
  }).sort(function(a,b){return b.count-a.count;});

  if(!rounds.length&&!rangeSessions.length){
    body.innerHTML='<div style="font-size:.65rem;color:var(--tx3);padding:4px 0">Play some rounds to see your stats.</div>';
    return;
  }

  var pct=function(a,b){return b>0?Math.round(a/b*100)+'%':'\u2014';};
  var fix=function(v){return v.toFixed(1);};
  var sgFmt=function(v){return (v>0?'+':'')+v.toFixed(2);};
  var sgCol=function(v){return v>0?'var(--ac2)':v<0?'var(--danger)':'var(--tx2)';};
  var lbl=function(t){return '<div style="font-size:.52rem;letter-spacing:.08em;text-transform:uppercase;color:var(--tx3);margin-bottom:1px">'+t+'</div>';};
  var bigVal=function(v,col){return '<div style="font-size:.66rem;color:'+(col||'var(--tx2)')+';font-weight:600">'+v+'</div>';};
  var statRow=function(l,v,vc){return '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--br)"><span style="font-size:.6rem;color:var(--tx3)">'+l+'</span><span style="font-size:.62rem;color:'+(vc||'var(--tx2)')+';font-weight:600">'+v+'</span></div>';};
  var secHdr=function(t){return '<div style="font-size:.52rem;letter-spacing:.08em;text-transform:uppercase;color:var(--tx3);padding:8px 0 4px;border-top:1px solid var(--br);margin-top:4px">'+t+'</div>';};
  var pholder=function(t){return '<div style="font-size:.6rem;font-style:italic;color:var(--tx3);padding:5px 0">'+t+'</div>';};

  var html='';
  html+='<div style="font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--tx2);font-weight:700;padding-bottom:6px">On the Course</div>';

  if(rounds.length){
    // Quick-glance row
    var firStr=firElig>0?firHit+'/'+firElig+' ('+pct(firHit,firElig)+')':'\u2014';
    var girStr=girElig>0?girHit+'/'+girElig+' ('+pct(girHit,girElig)+')':'\u2014';
    var puttStr=puttRounds>0?fix(puttTotal/puttRounds):'\u2014';
    var qc=function(l,v,border){return '<div style="flex:1;text-align:center;padding:6px 4px'+(border?';border-right:1px solid var(--br)':'')+'">'+ lbl(l)+bigVal(v)+'</div>';};
    html+='<div style="display:flex;border:1px solid var(--br);border-radius:5px;overflow:hidden;margin-bottom:10px">';
    html+=qc('FIR',firStr,true);
    html+=qc('GIR',girStr,true);
    html+=qc('Avg Putts',puttStr,false);
    html+='</div>';

    // SG
    if(hasSGFn&&sgRounds>0){
      html+=secHdr('Strokes Gained');
      html+='<div style="text-align:center;padding:4px 0 8px">';
      html+='<div style="font-size:.52rem;color:var(--tx3);letter-spacing:.08em;text-transform:uppercase">Total &middot; '+sgRounds+' round'+(sgRounds!==1?'s':'')+'</div>';
      html+='<div style="font-size:.9rem;font-weight:700;color:'+sgCol(sgTotals.total)+'">'+sgFmt(sgTotals.total)+'</div>';
      html+='</div>';
      html+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-bottom:8px">';
      [['OTT',sgTotals.ott],['APP',sgTotals.app],['ARG',sgTotals.arg],['PUTT',sgTotals.putt]].forEach(function(pair){
        html+='<div style="text-align:center;border:1px solid var(--br);border-radius:4px;padding:5px 2px">'+lbl(pair[0])+'<span style="font-size:.64rem;font-weight:600;color:'+sgCol(pair[1])+'">'+sgFmt(pair[1])+'</span></div>';
      });
      html+='</div>';
    }

    // Course Management
    html+=secHdr('Course Management');
    if(parGroups[3].n||parGroups[4].n||parGroups[5].n){
      html+='<div style="display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:2px 6px;align-items:center;margin-bottom:8px">';
      html+='<div style="font-size:.52rem;text-transform:uppercase;letter-spacing:.06em;color:var(--tx3)">Avg vs par</div>';
      [3,4,5].forEach(function(p){html+='<div style="font-size:.52rem;text-transform:uppercase;letter-spacing:.06em;color:var(--tx3);text-align:center">Par '+p+'</div>';});
      html+='<div></div>';
      [3,4,5].forEach(function(p){
        var g=parGroups[p];
        var avg=g.n>0?g.s/g.n:null;
        var col=avg===null?'var(--tx3)':avg<0?'var(--ac2)':avg>0?'var(--danger)':'var(--tx2)';
        html+='<div style="text-align:center;font-size:.66rem;font-weight:600;color:'+col+'">'+(avg===null?'\u2014':(avg>0?'+':'')+fix(avg))+'</div>';
      });
      html+='</div>';
    }
    if(birdiesOrBetter||bogeysOrWorse){
      html+=statRow('Birdies &amp; better',birdiesOrBetter||'\u2014','var(--ac2)');
      html+=statRow('Bogeys &amp; worse',bogeysOrWorse||'\u2014','var(--danger)');
    }
    if(totalPuttHoles>0){
      html+=statRow('1-putt %',pct(onePuttCount,totalPuttHoles));
      html+=statRow('3-putt %',pct(threePuttCount,totalPuttHoles));
    }
    if(puttsOnGIRCount>0)html+=statRow('Avg putts / GIR',fix(puttsOnGIR/puttsOnGIRCount));
    if(scrambleElig>0)html+=statRow('Scrambling',scrambleHit+'/'+scrambleElig+' ('+pct(scrambleHit,scrambleElig)+')');
    html+=pholder('Approach &amp; Tee \u2014 coming soon');
  } else {
    html+='<div style="font-size:.65rem;color:var(--tx3);padding:4px 0">Play some rounds to see your stats.</div>';
  }

  /* ASKB-1 -- inner helpers extracted to geo.js (BUCKET_NAMES, tagLookup, dominantMiss, shotTag). Originals commented, not deleted.
  var _bucketNames=['Long','Long-Right','Right','Short-Right','Short','Short-Left','Left','Long-Left'];
  var _tagLookup=function(path,miss,sev){
    if(!miss||miss==='\u2014') return 'Target';
    if(path==='Str'){
      if(miss==='Right'||miss==='Long-Right') return 'Push';
      if(miss==='Left'||miss==='Long-Left') return 'Pull';
      if(miss==='Short') return 'Chunk/Thin';
      return '\u2014';
    }
    if(path==='LtR'){
      if(miss==='Right'||miss==='Long-Right') return sev==='Inner'?'Fade':'Slice';
      if(miss==='Left'||miss==='Long-Left') return 'Double Cross (LtR)';
      return '\u2014';
    }
    if(path==='RtL'){
      if(miss==='Left'||miss==='Long-Left') return sev==='Inner'?'Draw':'Hook';
      if(miss==='Right'||miss==='Long-Right') return 'Double Cross (RtL)';
      return '\u2014';
    }
    return '\u2014';
  };
  var _dominantMiss=function(d){
    var buckets=[];
    for(var i=0;i<8;i++) buckets.push({i:i,n:(d.inner[i]||0)+(d.outer[i]||0),outerN:d.outer[i]||0});
    buckets.sort(function(a,b){return b.n-a.n;});
    if(!buckets[0].n) return '\u2014';
    if(buckets[0].n>buckets[1].n) return _bucketNames[buckets[0].i];
    var topN=buckets[0].n, tied=buckets.filter(function(b){return b.n===topN;});
    if(tied.length===2){
      var ai=tied[0].i, bi=tied[1].i;
      if(tied[0].outerN!==tied[1].outerN) return _bucketNames[tied[0].outerN>tied[1].outerN?tied[0].i:tied[1].i];
      var diff=Math.abs(ai-bi);
      if(diff===4){
        var an=_bucketNames[ai],bn=_bucketNames[bi];
        return ((an==='Right'||bn==='Right')||(an==='Left'||bn==='Left'))?'Two-Way Miss (L/R)':'Two-Way Miss (Dist)';
      }
      var mn=Math.min(ai,bi),mx=Math.max(ai,bi);
      var adj=(mx-mn===1)||(mn===0&&mx===7);
      if(adj){
        var combos={0:{'1':'Broad Long-Right'},1:{'2':'Broad Right'},2:{'3':'Broad Short-Right'},3:{'4':'Broad Short'},4:{'5':'Broad Short-Left'},5:{'6':'Broad Left'},6:{'7':'Broad Long-Left'}};
        var wrap=(mn===0&&mx===7)?'Broad Long':null;
        return wrap||(combos[mn]&&combos[mn][mx])||_bucketNames[buckets[0].i];
      }
    }
    return _bucketNames[buckets[0].i];
  };
  var _shotTag=function(d,miss){
    var innerTot=d.inner.reduce(function(n,v){return n+v;},0);
    var outerTot=d.outer.reduce(function(n,v){return n+v;},0);
    var grandTot=d.bull+innerTot+outerTot;
    if(!grandTot) return '\u2014';
    if(d.bull/grandTot>0.5||!miss||miss==='\u2014') return 'Target';
    var sev=innerTot>=outerTot?'Inner':'Outer';
    var fp=d.fp, fpTot=fp.str+fp.ltr+fp.rtl;
    if(!fpTot) return '\u2014';
    var paths=[['Str',fp.str],['LtR',fp.ltr],['RtL',fp.rtl]];
    paths.sort(function(a,b){return b[1]-a[1];});
    if(paths[0][1]>paths[1][1]) return _tagLookup(paths[0][0],miss,sev);
    if(miss.indexOf('Two-Way')===0) return 'Two-Way Miss';
    var sevW={'Hook':3,'Slice':3,'Pull':2,'Push':2,'Draw':1,'Fade':1};
    var t1=_tagLookup(paths[0][0],miss,sev), t2=_tagLookup(paths[1][0],miss,sev);
    return (sevW[t1]||0)>=(sevW[t2]||0)?t1:t2;
  };
  */
  var _bucketNames = BUCKET_NAMES;           /* ASKB-1 alias -- shim for downstream refs */
  var _tagLookup   = tagLookup;              /* ASKB-1 */
  var _dominantMiss = dominantMiss;          /* ASKB-1 */
  var _shotTag     = shotTag;                /* ASKB-1 */

  // Range display
  html+='<div style="font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--tx2);font-weight:700;padding:10px 0 6px;border-top:1px solid var(--br);margin-top:4px">Range</div>';
  if(clubEntries.length){
    var gcols='2fr 1fr 1fr 1fr 10px 1fr 1fr 1fr 10px 1fr 2fr 1fr';
    var ghdr='<div style="display:grid;grid-template-columns:'+gcols+';gap:0 4px;align-items:center;padding:3px 0;border-bottom:2px solid var(--br);font-size:.5rem;text-transform:uppercase;letter-spacing:.07em;color:var(--tx3)">';
    ghdr+='<span>Club</span><span>Bull</span><span>Inn</span><span>Out</span><span></span>';
    ghdr+='<span>Str</span><span>LtR</span><span>RtL</span><span></span>';
    ghdr+='<span style="text-align:right">Shots</span><span>Miss</span><span>Tag</span>';
    ghdr+='</div>';
    html+=ghdr;
    clubEntries.forEach(function(e){
      var d=e.disp, hasStats=e.count>=5&&d;
      var bull='\u2014',inn='\u2014',out='\u2014',str='\u2014',ltr='\u2014',rtl='\u2014',miss='\u2014',tag='\u2014';
      if(hasStats){
        var innerTot=d.inner.reduce(function(n,v){return n+v;},0);
        var outerTot=d.outer.reduce(function(n,v){return n+v;},0);
        var grandTot=d.bull+innerTot+outerTot;
        var fpTot=d.fp.str+d.fp.ltr+d.fp.rtl;
        if(grandTot){bull=Math.round(d.bull/grandTot*100)+'%';inn=Math.round(innerTot/grandTot*100)+'%';out=Math.round(outerTot/grandTot*100)+'%';}
        if(fpTot){str=Math.round(d.fp.str/fpTot*100)+'%';ltr=Math.round(d.fp.ltr/fpTot*100)+'%';rtl=Math.round(d.fp.rtl/fpTot*100)+'%';}
        miss=_dominantMiss(d); tag=_shotTag(d,miss);
      }
      var c='font-size:.58rem;color:var(--tx3)';
      html+='<div style="display:grid;grid-template-columns:'+gcols+';gap:0 4px;align-items:center;padding:3px 0;border-bottom:1px solid var(--br)">';
      html+='<span style="'+c+';color:var(--tx2);font-weight:600">'+e.name+'</span>';
      html+='<span style="'+c+'">'+bull+'</span><span style="'+c+'">'+inn+'</span><span style="'+c+'">'+out+'</span><span></span>';
      html+='<span style="'+c+'">'+str+'</span><span style="'+c+'">'+ltr+'</span><span style="'+c+'">'+rtl+'</span><span></span>';
      html+='<span style="'+c+';text-align:right">'+e.count+'</span>';
      html+='<span style="'+c+'">'+miss+'</span>';
      html+='<span style="'+c+';font-weight:600;color:var(--tx2)">'+tag+'</span>';
      html+='</div>';
    });
  } else {
    html+='<div style="font-size:.65rem;color:var(--tx3);padding:4px 0">No range sessions yet.</div>';
  }

  body.innerHTML=html;
}

// -- Tab navigation (programmatic) --------------------------------------------
function showTabFromProfile(id) {
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+id)?.classList.add('active');
  const tabBtn = [...document.querySelectorAll('.tab')].find(t=>t.getAttribute('onclick')?.includes("'"+id+"'"));
  if(tabBtn) tabBtn.classList.add('active');
  if(id==='clubs')    renderClubs();
  if(id==='courses')  renderCourseList();
  if(id==='rounds')   renderHandicap();
  if(id==='sessions') window.renderSessions();
  if(id==='profile')  renderProfile();
}

// -- Profile dropdown ---------------------------------------------------------
function toggleProfileDropdown() {
  const dd=document.getElementById('profDropdown');
  if(!dd) return;
  if(dd.classList.contains('open')) { closeProfileDropdown(); return; }
  renderDropdown();
  dd.classList.add('open');
  setTimeout(()=>document.addEventListener('click', _ddOutsideClose, {once:true}), 0);
}
function closeProfileDropdown() {
  document.getElementById('profDropdown')?.classList.remove('open');
  document.removeEventListener('click', _ddOutsideClose);
}
function _ddOutsideClose(e) {
  const dd=document.getElementById('profDropdown');
  const btn=document.getElementById('hdrAvatarBtn');
  if(dd&&!dd.contains(e.target)&&!btn?.contains(e.target)) closeProfileDropdown();
}
function ddNav(tab) {
  closeProfileDropdown();
  showTabFromProfile(tab);
}

function renderDropdown() {
  const name=profile.name||'Golfer';
  const hcp=getHandicap();
  const initials=name.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'\u26F3';
  const homeCourse=courses.find(c=>c.id===profile.homeCourseId);
  const activeClubs=bag.filter(c=>c.type!=='Putter'&&c.tested);

  const ddName=document.getElementById('ddName');
  const ddHcp=document.getElementById('ddHcp');
  if(ddName) ddName.textContent=name==='Golfer'?'Welcome, Golfer':name;
  if(ddHcp) ddHcp.textContent='Handicap Index: '+(hcp!==null?hcp:'\u2014');

  const ini=document.getElementById('hdrAvatarInitials');
  if(ini) ini.textContent=initials;

  const el=id=>document.getElementById(id);
  if(el('ddRounds')) el('ddRounds').textContent=rounds.length+' logged'+(rounds.length?` \u00B7 HCP ${hcp!==null?hcp:'\u2014'}`:'');
  if(el('ddSessions')) el('ddSessions').textContent=history.filter(h=>h.type!=='data-update').length+' caddie session'+(history.length!==1?'s':'');
  if(el('ddCourses')) el('ddCourses').textContent=courses.length+' saved'+(homeCourse?' \u00B7 Home: '+homeCourse.name:'');
  if(el('ddClubs')) el('ddClubs').textContent=activeClubs.length+' active'+(activeClubs.length?' \u00B7 '+_clubRange(activeClubs):'');

  const ts=localStorage.getItem('vc:kvLastSync');
  const tsMs=localStorage.getItem('vc:kvLastSyncTs');
  const offline=!navigator.onLine;
  const pending=!!localStorage.getItem('vc:kvPendingPush');
  const hasPass=!!sessionStorage.getItem('vc:kvPass');
  const syncSt=el('ddSyncStatus');
  const syncBtns=el('ddSyncBtns');
  const dot=el('hdrAvatarDot');

  if(kvMode()) {
    const dotColor=offline?'var(--gold)':pending?'var(--gold)':'var(--gr)';
    if(dot) dot.style.background=dotColor;
    const label=offline?'\uD83D\uDCF5 Offline':pending?'\u23F3 Push pending':ts?`\uD83D\uDFE2 Synced ${_fmtAgo(tsMs)}`:'\u26AA Connected \u2014 not synced';
    if(syncSt) syncSt.textContent=label;
    if(syncBtns) syncBtns.innerHTML=hasPass
      ?`<button class="btn" style="font-size:.6rem;padding:3px 8px" onclick="kvPush('kvSyncStatus')">\u2191 Push</button>
         <button class="btn sec" style="font-size:.6rem;padding:3px 8px" onclick="kvPull('kvSyncStatus')" ${offline?'disabled':''}>\u2193 Pull</button>`
      :`<button class="btn sec" style="font-size:.6rem;padding:3px 8px" onclick="closeProfileDropdown();showTabFromProfile('profile')">Unlock sync \u2192</button>`;
  } else {
    if(dot) dot.style.background='#888';
    if(syncSt) syncSt.textContent='\u26AA No sync profile';
    if(syncBtns) syncBtns.innerHTML=`<button class="btn gold" style="font-size:.6rem;padding:3px 8px" onclick="closeProfileDropdown();showTabFromProfile('profile')">Set up \u2192</button>`;
  }

  const sob=el('ddSignOutBlock');
  if(sob) sob.innerHTML=(kvMode()
    ?`<button class="btn danger" style="width:100%;font-size:.68rem;margin-bottom:4px" onclick="signOutSync()">\uD83D\uDD13 Sign out of sync</button>`
    :'')+
    `<button class="btn sec" style="width:100%;font-size:.68rem" onclick="signOut()">\u21A9 Sign out</button>`;
}

// -- Home course helpers ------------------------------------------------------
function onHomeClubSelect() {
  const val = document.getElementById('pfHomeClubSelect')?.value||'';
  if(val==='') { profile.homeClub=''; profile.homeCourseId=''; save(); renderProfileHero(); renderCourseList(); return; }
  const course = courses.find(c=>c.id===val);
  if(course) { profile.homeClub=course.name; profile.homeCourseId=course.id; save(); renderProfileHero(); renderCourseList(); }
}
function onHomeClubInput() {
  const val = document.getElementById('pfHomeClub')?.value||'';
  const match = courses.find(c=>c.name.toLowerCase()===val.toLowerCase());
  profile.homeClub = val;
  profile.homeCourseId = match ? match.id : '';
  save();
  renderProfileHero();
  const coursesPanel = document.getElementById('tab-courses');
  if(coursesPanel&&coursesPanel.classList.contains('active')) renderCourseList();
}

// -- Course dropdowns (called from rounds.js and caddie.js as global) ---------
function updateCourseDropdowns() {
  const sel = document.getElementById('rCourseSelect');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">\u2014 Select saved course \u2014</option>'
    + courses.map(c=>`<option value="${c.id}">${c.name}${c.city?' \u00B7 '+c.city:''}</option>`).join('')
    + '<option value="__manual__">Enter manually\u2026</option>';
  if(cur && (cur==='__manual__' || courses.find(c=>c.id===cur))) sel.value=cur;
}

// -- App orchestrator (called at startup and after data changes) --------------
export function renderAll() {
  setVizInitDone(false);
  renderProfile(); renderClubs(); renderCourseList(); renderHandicap();
  window.renderAIHelp(); window.updateCourseSelects(); window.renderSessions();
  // Set rCourse autofill once
  const rc=document.getElementById('rCourse');
  if(rc&&!rc._listenerSet){rc._listenerSet=true;rc.addEventListener('change',function(){
    const c=courses.find(x=>x.name===this.value);
    if(c){const r=document.getElementById('rRating'),s=document.getElementById('rSlope'),p=document.getElementById('rPar');if(r)r.value=c.rating;if(s)s.value=c.slope;if(p)p.value=c.par;window.updateDiffPreview();}
  });}
  if(window.updateChecklist) window.updateChecklist();
  if(window.updateSessionLinker) window.updateSessionLinker();
  if(window.renderBanner) window.renderBanner();
}

// -- Modals -------------------------------------------------------------------

/* UI-α1 — shared confirm modal; reuses .disc-overlay/.disc-box pattern */
function showConfirmModal(title, message, onConfirm, danger) {
  if (danger === undefined) danger = true;
  var m = document.getElementById('confirmModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'confirmModal';
    m.className = 'disc-overlay';
    m.style.display = 'none';
    m.innerHTML =
      '<div class="disc-box" style="max-width:420px">' +
        '<div id="confirmModal-title" class="disc-title"></div>' +
        '<div class="disc-section"><div id="confirmModal-msg" class="disc-body" style="line-height:1.7"></div></div>' +
        '<div class="disc-footer" style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn sec" id="confirmModal-cancel">Cancel</button>' +
          '<button class="btn" id="confirmModal-ok">Confirm</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
  }
  document.getElementById('confirmModal-title').textContent = title;
  document.getElementById('confirmModal-msg').textContent = message;
  var okBtn = document.getElementById('confirmModal-ok');
  okBtn.style.background = danger ? 'var(--danger)' : '';
  okBtn.style.borderColor = danger ? 'var(--danger)' : '';
  okBtn.style.color = danger ? '#fff' : '';
  okBtn.textContent = 'Confirm';
  var cancelBtn = document.getElementById('confirmModal-cancel');
  var close = function() { m.style.display = 'none'; };
  okBtn.onclick = function() { close(); onConfirm(); };
  cancelBtn.onclick = close;
  m.onclick = function(e) { if (e.target === m) close(); };
  m.style.display = 'flex';
}

function showDisclaimer() {
  document.getElementById('discModal').style.display = 'flex';
}
function acceptDisclaimer() {
  localStorage.setItem('vc:disc', '1');
  document.getElementById('discModal').style.display = 'none';
}
function confirmClearAll() {
  ['vc:bag','vc:courses','vc:rounds','vc:history','vc:profile','vc:hcpMode','vc:manualHcp','vc:version',
   'gordy:activeRound','gordy:activeRange','vc:rangeSessions'].forEach(k=>localStorage.removeItem(k));
  clearAll();
  document.getElementById('clearModal').style.display='none';
  if(window.renderBanner) window.renderBanner(); else document.getElementById('uploadBanner').style.display='flex';
  renderAll();
  if(window.updateSessionPill) window.updateSessionPill();
}
function signOut() {
  ['vc:gateUnlocked','vc:kvPass','vc:verify','vc:siteVerify'].forEach(k=>sessionStorage.removeItem(k)); /* GUEST2 */
  location.reload();
}

// -- Polish B: checklist, banner, AI steps, session linker --------------------

function updateChecklist() {
  var card = document.getElementById('firstRunCard');
  if (!card) return;
  var raw = localStorage.getItem('gordy:checklist');
  var state = raw ? JSON.parse(raw) : null;
  if (state && state.dismissed) { card.style.display = 'none'; return; }
  var b = bag; var c = courses; var h = history;
  var s1done = b.filter(function(cl){ return cl.active && cl.sessions && cl.sessions.length > 0; }).length >= 1;
  var s2done = c.length >= 1;
  var s3done = h.length >= 1;
  function setStep(id, done) {
    var el = document.getElementById(id); if (!el) return;
    var icon = el.querySelector('.checklist-icon');
    if (icon) icon.textContent = done ? '\u2713' : '\u25CB';
    if (done) el.classList.add('done'); else el.classList.remove('done');
  }
  setStep('checklistStep1', s1done);
  setStep('checklistStep2', s2done);
  setStep('checklistStep3', s3done);
  card.style.display = 'block';
  if (s1done && s2done && s3done) {
    setTimeout(function() {
      localStorage.setItem('gordy:checklist', JSON.stringify({dismissed:true}));
      card.style.display = 'none';
    }, 2000);
  }
}
function dismissChecklist() {
  localStorage.setItem('gordy:checklist', JSON.stringify({dismissed:true}));
  var card = document.getElementById('firstRunCard');
  if (card) card.style.display = 'none';
}
function showFirstRunCard() {
  var existing = localStorage.getItem('gordy:checklist');
  if (existing) { try { var s = JSON.parse(existing); if (s.dismissed) return; } catch(e) {} }
  localStorage.setItem('gordy:checklist', JSON.stringify({dismissed:false}));
  var card = document.getElementById('firstRunCard');
  if (card) card.style.display = 'block';
  updateChecklist();
}

function renderBanner() {
  var el = document.getElementById('uploadBanner'); if (!el) return;
  if (sessionStorage.getItem('gordy:bannerDismissed')) { el.style.display = 'none'; return; }
  var kvId = localStorage.getItem('vc:kvId');
  var isGuest = sessionStorage.getItem('vc:gateUnlocked') === 'guest';
  var hasData = bag.length || courses.length || rounds.length || history.length;
  if (!kvId && !hasData && !isGuest) { el.style.display = 'none'; return; }
  if (isGuest) { el.style.display = 'none'; return; }
  if (kvId && !hasData) {
    el.style.display = 'block';
    el.innerHTML = '<div class="card" style="margin:0;border-left:3px solid var(--gr2);width:100%"><div class="card-title">Welcome back</div><p style="font-size:.74rem;color:var(--tx2);margin-bottom:10px">No local data on this device.</p><div style="display:flex;gap:8px"><button class="btn" onclick="manualPull()">\u2193 Pull from sync</button><button class="btn sec" onclick="dismissBanner()">Start fresh</button></div></div>';
    return;
  }
  if (!kvId && hasData) {
    el.innerHTML = '<div class="ub-text"><strong>Welcome to GORDy the Virtual Caddy</strong>Import an existing data file, load from sync, or start fresh and set up your clubs and courses with AI.</div><label class="btn gold" style="cursor:pointer;white-space:nowrap">&#8679; Import Data File<input type="file" accept=".txt" style="display:none" onchange="importData(event);dismissBanner()"></label><button class="btn gold" onclick="bannerLoadGist()" style="white-space:nowrap" id="bannerGistBtn">&#8681; Load from sync</button><button class="btn sec" onclick="exportStarterTxt()" style="white-space:nowrap">\uD83E\uDD16 Set Up with AI</button><button class="btn sec" onclick="dismissBanner()" style="white-space:nowrap">Start fresh</button>';
    el.style.display = 'flex';
    return;
  }
  if (kvId && hasData && sessionStorage.getItem('gordy:cloudNewer') === '1') {
    el.style.display = 'block';
    el.innerHTML = '<div class="card" style="margin:0;border-left:3px solid var(--sand);width:100%"><div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:.74rem;color:var(--tx2)">\u26A0 Your sync profile has newer data.</span><div style="display:flex;gap:6px"><button class="btn sec" onclick="manualPull()">\u2193 Pull</button><button class="btn sec" onclick="dismissBanner()">Dismiss</button></div></div></div>';
    return;
  }
  el.style.display = 'none';
}
function dismissBanner() {
  sessionStorage.setItem('gordy:bannerDismissed', '1');
  var el = document.getElementById('uploadBanner');
  if (el) el.style.display = 'none';
}
function manualPull() { if (window.dbPull) window.dbPull(); }

const _aiStepsMap = {
  pasteResult:       'aiStepsForAI',
  pasteRoundResult:  'aiStepsRound',
  pasteClubResult:   'aiStepsClub',
  pasteCourseResult: 'aiStepsCourse'
};
function showAIStepsCard(cardId) {
  const el = document.getElementById(cardId);
  if (el) el.style.display = 'block';
}
function hideAIStepsCard(pasteId) {
  const cardId = _aiStepsMap[pasteId]; if (!cardId) return;
  const el = document.getElementById(cardId);
  if (el) el.style.display = 'none';
}

function updateSessionLinker() {
  const todayStr = today();
  const unlinked = history.filter(s => (!s.roundId) && s.date && s.date.slice(0, 10) === todayStr);
  const linkerBody = document.getElementById('rSessLinker');
  if (linkerBody) linkerBody.style.display = unlinked.length > 0 ? 'block' : 'none';
}

Object.assign(window, {
  saveData, exportData, processDataText, dbLoadData, importData, onMergeFile,
  showTab, saveProfile, renderProfileHero, renderProfile,
  showTabFromProfile,
  toggleProfileDropdown, closeProfileDropdown, ddNav, renderDropdown,
  onHomeClubSelect, onHomeClubInput,
  updateCourseDropdowns, renderAll, serialise,
  showDisclaimer, acceptDisclaimer, confirmClearAll, signOut,
  showConfirmModal,
  updateChecklist, dismissChecklist, showFirstRunCard,
  renderBanner, dismissBanner, manualPull,
  showAIStepsCard, hideAIStepsCard,
  updateSessionLinker
});
