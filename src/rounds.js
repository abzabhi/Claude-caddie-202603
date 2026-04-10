import { calcHandicap, calcDiff, fmtDate, deriveStats, calcImplied } from './geo.js';
import { rounds, history, bag, courses, profile, removeRound, save, today } from './store.js';
import { getTypeLabel } from './clubs.js';

function renderHandicap() {
  const rDateEl=document.getElementById('rDate'); if(rDateEl) rDateEl.value=today();
  updateCourseDropdowns();
  const mode = localStorage.getItem('vc:hcpMode')||'calculated';
  const calcHcp = calcHandicap(rounds);
  const manualVal = localStorage.getItem('vc:manualHcp')||'';
  const hcp = mode==='manual'&&manualVal?parseFloat(manualVal):calcHcp;
  const isManual = mode==='manual';
  const tc=document.getElementById('toggleCalc'), tm=document.getElementById('toggleManual');
  if(tc&&tm){tc.className=isManual?'btn sec':'btn';tm.className=isManual?'btn':'btn sec';}
  const mf=document.getElementById('manualHcpField'), cf=document.getElementById('calcHcpField');
  if(mf) mf.style.display=isManual?'block':'none';
  if(cf) cf.style.display=isManual?'none':'block';
  const mInput=document.getElementById('manualHcp');
  if(mInput&&manualVal) mInput.value=manualVal;
  document.getElementById('hcpNum').textContent = hcp!==null?hcp:'\u2014';
  document.getElementById('hcpNum').style.fontSize = hcp!==null?'2.8rem':'1.3rem';
  document.getElementById('hcpNum').style.color = isManual?'var(--gold)':hcp!==null?'var(--ac2)':'var(--tx3)';
  document.getElementById('hcpLbl').textContent = isManual?'Handicap Index (Manual)':'Handicap Index';
  const n=rounds.length;
  const take=n>=20?8:n>=17?7:n>=15?6:n>=12?5:n>=10?4:n>=9?3:n>=7?2:1;
  document.getElementById('hcpMeta').textContent = hcp!==null?`${n} round${n!==1?'s':''} \u00B7 best ${Math.min(take,n)} differentials \u00B7 WHS formula`:'Log a round to calculate';
  document.getElementById('roundCount').textContent=`(${n})`;
  document.getElementById('roundHistCard').style.display=n?'block':'none';

  const eligible = rounds.filter(r=>r.countForHandicap!==false && !(r.players?.length>=2));
  const top20Ids = new Set(eligible.slice(0,20).map(r=>r.id));
  const buckets = {active:[], excluded:[], multi:[], archive:[]};
  rounds.forEach(r=>{
    if(r.players?.length>=2)           buckets.multi.push(r);
    else if(r.countForHandicap===false) buckets.excluded.push(r);
    else if(top20Ids.has(r.id))        buckets.active.push(r);
    else                               buckets.archive.push(r);
  });

  const renderRound = r => {
    const hasDetail = r.holes?.length>0;
    const isMulti   = r.players?.length>=2;
    const gir    = r.holes?.filter(h=>h.gir===true).length;
    const girOf  = r.holes?.filter(h=>h.gir!==null).length;
    const girStr = girOf>0?`GIR: ${gir}/${girOf} \u00B7 `:'';
    const linkedBadges=(r.sessionIds||[]).map(sid=>{
      const s=history.find(h=>h.id===sid);
      if(!s) return '';
      const ico=s.type==='manual'?'\u270F\uFE0F':'\uD83E\uDD16';
      return `<span class="rnd-badge">${ico} ${fmtDate(s.date)}</span>`;
    }).join('');
    const playerBadges = isMulti
      ? r.players.map(p=>`<span class="rnd-badge">${p.isMe?'\u2605 ':''} ${escHtml(p.name||'?')}${p.score?' \u00B7 '+p.score:''}</span>`).join('')
      : '';
    return `<div class="rnd-card" id="rnd-${r.id}">
      <div class="rnd-row">
        <input class="rnd-edit" type="date" value="${r.date}" onchange="updateRound('${r.id}','date',this.value)" style="width:100px">
        <input class="rnd-edit" type="text" value="${r.courseName||''}" placeholder="Course" onchange="updateRound('${r.id}','courseName',this.value)" style="flex:1;min-width:80px">
        <input class="rnd-edit" type="text" value="${r.tee||''}" placeholder="Tee" onchange="updateRound('${r.id}','tee',this.value)" style="width:60px">
        <input class="rnd-edit" type="text" inputmode="numeric" value="${r.score}" placeholder="Score" onchange="updateRound('${r.id}','score',this.value)" style="width:44px;text-align:center">
        <span class="rnd-diff" id="rdiff-${r.id}">${r.diff!==null?r.diff:'\u2014'}</span>
        <button class="rnd-del" onclick="rndToggleLink('${r.id}')" title="Link sessions" style="color:var(--tx3);font-size:.72rem">\uD83D\uDD17</button>
        ${isMulti?`<button class="rnd-del" onclick="rndRegenPdf('${r.id}')" title="Export scorecard PDF" style="font-size:.65rem">\uD83D\uDCC4</button>`:''}
        ${hasDetail?`<button class="rnd-del" onclick="rndToggleDetail('${r.id}')" title="Hole detail">\u25BC</button>`:''}
        <button style="background:var(--danger);color:white;border:1px solid var(--danger);border-radius:4px;cursor:pointer;font-size:1rem;padding:4px 8px;line-height:1" onclick="confirmDeleteRound('${r.id}')">\u2715</button>
      </div>
      <div class="rnd-meta">
        ${linkedBadges?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:${(r.notes||girStr||playerBadges)?'3px':'0'}">${linkedBadges}</div>`:''}
        ${playerBadges?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:${(r.notes||girStr)?'3px':'0'}">${playerBadges}</div>`:''}
        ${girStr||r.notes?`<div style="font-size:.58rem;color:var(--tx3)">${girStr}${escHtml(r.notes||'')}</div>`:''}
      </div>
      <div id="rnd-link-${r.id}" style="display:none;padding:4px 0 6px">${_rndLinkHTML(r)}</div>
      ${hasDetail?`<div id="rnd-detail-${r.id}" style="display:none;overflow-x:auto;padding-bottom:6px">${_rndDetailHTML(r)}</div>`:''}
    </div>`;
  };

  document.getElementById('roundListActive').innerHTML   = buckets.active.map(renderRound).join('')||'<div style="font-size:.65rem;color:var(--tx3);padding:8px 0">No active rounds yet.</div>';
  document.getElementById('roundListExcluded').innerHTML = buckets.excluded.map(renderRound).join('');
  document.getElementById('roundListMulti').innerHTML    = buckets.multi.map(renderRound).join('');
  document.getElementById('roundListArchive').innerHTML  = buckets.archive.map(renderRound).join('');

  const showSection = (secId, hdrId, countId, items) => {
    document.getElementById(secId).style.display = items.length ? '' : 'none';
    document.getElementById(countId).textContent = items.length ? `(${items.length})` : '';
  };
  showSection('roundExcludedSection','rndExcHdr','rndExcCount',buckets.excluded);
  showSection('roundMultiSection','rndMultiHdr','rndMultiCount',buckets.multi);
  showSection('roundArchiveSection','rndArchHdr','rndArchCount',buckets.archive);
  lrUpdatePill();
}

function onRoundCourseSelect() {
  const sel = document.getElementById('rCourseSelect');
  const val = sel?.value||'';
  const manualRow = document.getElementById('rManualCourseRow');
  const teeRow    = document.getElementById('rTeeSelectRow');
  if(document.getElementById('rSessLinker')?.style.display!=='none') _buildRndLinker();
  document.getElementById('rRating').value='';
  document.getElementById('rSlope').value='';
  document.getElementById('rPar').value='';
  document.getElementById('diffPreview').textContent='';
  if(val===''){ manualRow.style.display='none'; teeRow.style.display='none'; return; }
  if(val==='__manual__'){ manualRow.style.display=''; teeRow.style.display='none'; return; }
  const course = courses.find(c=>c.id===val);
  if(!course){ manualRow.style.display='none'; teeRow.style.display='none'; return; }
  manualRow.style.display='none';
  const teeSelect = document.getElementById('rTeeSelect');
  if(course.tees&&course.tees.length){
    teeSelect.innerHTML = course.tees.map(t=>`<option value="${t.id}">${t.name} \u2014 ${t.yardage} yds (Rating ${t.rating} / Slope ${t.slope})</option>`).join('');
    teeRow.style.display='';
    onRoundTeeSelect();
  } else {
    teeRow.style.display='none';
    document.getElementById('rRating').value=course.rating||'';
    document.getElementById('rSlope').value=course.slope||'';
    document.getElementById('rPar').value=course.par||'';
  }
}

function onRoundTeeSelect() {
  const cSel = document.getElementById('rCourseSelect')?.value||'';
  const course = courses.find(c=>c.id===cSel);
  if(!course) return;
  const teeId = document.getElementById('rTeeSelect')?.value||'';
  const tee = course.tees?.find(t=>t.id===teeId);
  if(!tee) return;
  document.getElementById('rRating').value=tee.rating||'';
  document.getElementById('rSlope').value=tee.slope||'';
  document.getElementById('rPar').value=course.par||'';
  updateDiffPreview();
  if(document.getElementById('rModeBtn')?.classList.contains('on')) _buildRoundHoleGrid();
}

function updateDiffPreview() {
  const d=calcDiff(document.getElementById('rScore').value,document.getElementById('rRating').value,document.getElementById('rSlope').value);
  document.getElementById('diffPreview').textContent=d!==null?'Differential: '+d:'';
}

function addRound() {
  const score=document.getElementById('rScore').value;
  const rating=document.getElementById('rRating').value;
  const slope=document.getElementById('rSlope').value;
  if(!score||!rating||!slope){alert('Gross score, course rating, and slope are required.');return;}
  const sel = document.getElementById('rCourseSelect')?.value||'';
  const isManual = sel==='' || sel==='__manual__';
  const courseName = isManual
    ? (document.getElementById('rCourse')?.value||'')
    : courses.find(c=>c.id===sel)?.name||'';
  const tee = isManual
    ? (document.getElementById('rTeeManual')?.value||'')
    : (document.getElementById('rTeeSelect')?.options[document.getElementById('rTeeSelect').selectedIndex]?.text||'');
  const diff=calcDiff(score,rating,slope);
  const notes=document.getElementById('rNotes')?.value||'';
  const sessionIds=[...document.querySelectorAll('.rnd-sess-chk:checked')].map(el=>el.value).filter(Boolean);
  const holes=[];
  document.querySelectorAll('.rnd-hole-row').forEach(row=>{
    const n=parseInt(row.dataset.hole);
    const sc=row.querySelector('.rh-score')?.value?.trim()||'';
    const pt=row.querySelector('.rh-putts')?.value?.trim()||'';
    const gBtn=row.querySelector('.rnd-gir-btn');
    const gir=gBtn?.dataset.gir==='Y'?true:gBtn?.dataset.gir==='N'?false:null;
    const nt=row.querySelector('.rh-notes')?.value?.trim()||'';
    if(sc||pt||gir!==null) holes.push({n,par:row.dataset.par||'',score:sc,putts:pt,gir,notes:nt,yards:row.dataset.yards||''});
  });
  rounds.unshift({id:uid(),date:document.getElementById('rDate').value||today(),courseName,tee,rating,slope,par:document.getElementById('rPar').value||'',score,diff,notes,sessionIds,holes});
  save(); renderHandicap();
  document.getElementById('rScore').value='';
  document.getElementById('rRating').value='';document.getElementById('rSlope').value='';
  document.getElementById('rPar').value='';document.getElementById('diffPreview').textContent='';
  document.getElementById('rCourseSelect').value='';
  if(document.getElementById('rNotes')) document.getElementById('rNotes').value='';
  if(document.getElementById('rCourse')) document.getElementById('rCourse').value='';
  if(document.getElementById('rTeeManual')) document.getElementById('rTeeManual').value='';
  document.getElementById('rManualCourseRow').style.display='none';
  document.getElementById('rTeeSelectRow').style.display='none';
  document.getElementById('rHoleGrid').style.display='none';
  document.getElementById('rSessLinker').style.display='none';
  const mBtn=document.getElementById('rModeBtn');
  if(mBtn){mBtn.textContent='Simple';mBtn.classList.remove('on');}
  document.querySelectorAll('.rnd-sess-chk').forEach(c=>{c.checked=false;});
}

function confirmDeleteRound(id) {
  if(document.getElementById('rnd-confirm-'+id)) return;
  var row = document.getElementById('rnd-'+id);
  if(!row) return;
  var strip = document.createElement('div');
  strip.id = 'rnd-confirm-'+id;
  strip.style.cssText = 'padding:6px 10px;font-size:.65rem;display:flex;gap:8px;align-items:center;border-top:1px solid var(--br);flex-wrap:wrap';
  strip.innerHTML = '<span style="color:var(--danger)">Delete this round?</span>' +
    '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);font-size:.6rem;padding:2px 8px" onclick="deleteRound(\'' + id + '\')">Delete</button>' +
    '<button class="btn sec" style="font-size:.6rem;padding:2px 8px" onclick="document.getElementById(\'rnd-confirm-' + id + '\').remove()">Cancel</button>';
  row.appendChild(strip);
}

function deleteRound(id) { removeRound(id); save(); renderHandicap(); }

function toggleRndSection(key){
  const ids = {excluded:'roundListExcluded', multi:'roundListMulti', archive:'roundListArchive'};
  const listEl = document.getElementById(ids[key]);
  if(!listEl) return;
  const open = listEl.style.display==='none';
  listEl.style.display = open?'block':'none';
  listEl.previousElementSibling?.querySelector('.chev')?.classList.toggle('open', open);
}

function rndRegenPdf(id) {
  const r = rounds.find(x=>x.id===id);
  if(!r||!r.players?.length) return;
  const savedState = lrState;
  const totalPar = parseInt(r.par)||72;
  const holeCount = r.holes?.length || 18;
  lrState = {
    courseName: r.courseName||'',
    tee: r.tee||'',
    date: r.date||today(),
    conditions: r.notes||'calm',
    mode: 'stroke',
    rating: r.rating||'',
    slope: r.slope||'',
    holes: r.holes?.length
      ? r.holes.map(h=>({n:+h.n,par:+h.par||4,yards:+h.yards||0,handicap:0}))
      : Array.from({length:holeCount},(_,i)=>({n:i+1,par:4,yards:0,handicap:0})),
    players: r.players.map(p=>({
      name: p.name||'Player',
      isMe: p.isMe||false,
      handicap: p.handicap||null,
      scores: r.holes?.length
        ? r.holes.map(h=>({score:+h.score||null,putts:+h.putts||null,gir:h.gir,notes:h.notes||''}))
        : Array.from({length:holeCount},()=>({score:null,putts:null,gir:null,notes:''})),
    })),
    netView: false,
  };
  lrExportPdf();
  lrState = savedState;
}

function _rndLinkHTML(r){
  const cn=(r.courseName||'').toLowerCase();
  const matching=history.filter(h=>(h.type==='manual'||h.type==='optimisation'||h.type==='caddie'||h.type==='both')&&(h.course||'').toLowerCase().split(' ').some(w=>w&&cn.includes(w)));
  if(!matching.length) return '<div style="font-size:.62rem;color:var(--tx3);padding:2px 0">No sessions for this course yet.</div>';
  const ids=r.sessionIds||[];
  return `<div style="font-size:.6rem;color:var(--tx3);margin-bottom:4px;letter-spacing:.06em;text-transform:uppercase">Link caddie sessions</div>`
    +matching.map(s=>{
      const ico=s.type==='manual'?'\u270F\uFE0F':'\uD83E\uDD16';
      const checked=ids.includes(s.id)?'checked':'';
      return `<label style="display:flex;align-items:center;gap:6px;font-size:.62rem;color:var(--tx2);padding:2px 0;cursor:pointer"><input type="checkbox" class="rnd-link-chk" data-rid="${r.id}" value="${s.id}" ${checked}> ${ico} ${fmtDate(s.date)} \u00B7 ${escHtml(s.course||'')} (${escHtml(s.tee||'')})</label>`;
    }).join('')
    +`<button class="btn" style="margin-top:6px;font-size:.6rem;padding:3px 10px" onclick="rndSaveLinks('${r.id}')">Save</button>`;
}

function _rndDetailHTML(r){
  const holes=r.holes||[];
  if(!holes.length) return '';
  const front=holes.filter(h=>h.n>=1&&h.n<=9);
  const back=holes.filter(h=>h.n>=10&&h.n<=18);
  const sum=(hs,f)=>hs.reduce((t,h)=>{const v=parseInt(f(h));return t+(isNaN(v)?0:v);},0);
  const girN=(hs)=>hs.filter(h=>h.gir===true).length;
  const hasVal=(hs,f)=>hs.some(h=>f(h)!==''&&f(h)!==null&&f(h)!==undefined);
  const fmtSub=(v,hs,f)=>hasVal(hs,f)?String(v):'\u2014';
  const fmtGirSub=(v,hs)=>hs.some(h=>h.gir!==null)?String(v):'\u2014';
  const renderRows=hs=>hs.map(h=>{
    const parN=parseInt(h.par)||0;
    const cls=parN===3?'par3-row':parN===5?'par5-row':'';
    return `<tr class="${cls}">
      <td style="font-weight:600;color:var(--tx2)">${h.n}</td>
      <td>${h.par||'\u2014'}</td>
      <td style="color:var(--tx3)">${h.yards||'\u2014'}</td>
      <td style="font-weight:600">${h.score||'\u2014'}</td>
      <td>${h.putts||'\u2014'}</td>
      <td style="color:${h.gir===true?'var(--ac2)':h.gir===false?'#c06060':'var(--tx3)'}">${h.gir===true?'Y':h.gir===false?'N':'\u2014'}</td>
      <td style="text-align:left;color:var(--tx3);font-size:.55rem">${escHtml(h.notes||'')}</td>
    </tr>`;
  }).join('');
  const subRow=(lbl,hs)=>`<tr class="subtotal-row">
    <td class="sub-lbl" colspan="3" style="text-align:right;padding-right:6px">${lbl}</td>
    <td style="text-align:center;font-weight:600">${fmtSub(sum(hs,h=>h.score),hs,h=>h.score)}</td>
    <td style="text-align:center">${fmtSub(sum(hs,h=>h.putts),hs,h=>h.putts)}</td>
    <td style="text-align:center">${fmtGirSub(girN(hs),hs)}</td>
    <td></td>
  </tr>`;
  const tbl=(hs,showSub,subLbl)=>`<table class="rnd-hole-tbl">
    <thead><tr><th>H</th><th>Par</th><th>Yds</th><th>Score</th><th>Putts</th><th>GIR</th><th style="text-align:left">Notes</th></tr></thead>
    <tbody>${renderRows(hs)}${showSub?subRow(subLbl,hs):''}</tbody>
  </table>`;
  const allTbl=`<table class="rnd-hole-tbl">
    <thead><tr><th>H</th><th>Par</th><th>Yds</th><th>Score</th><th>Putts</th><th>GIR</th><th style="text-align:left">Notes</th></tr></thead>
    <tbody>${renderRows(front)}${front.length?subRow('OUT',front):''}${renderRows(back)}${back.length?subRow('IN',back):''}
    ${front.length&&back.length?`<tr class="subtotal-row">
      <td class="sub-lbl" colspan="3" style="text-align:right;padding-right:6px">TOTAL</td>
      <td style="text-align:center;font-weight:600">${fmtSub(sum(holes,h=>h.score),holes,h=>h.score)}</td>
      <td style="text-align:center">${fmtSub(sum(holes,h=>h.putts),holes,h=>h.putts)}</td>
      <td style="text-align:center">${fmtGirSub(girN(holes),holes)}</td>
      <td></td>
    </tr>`:''}
    </tbody>
  </table>`;
  return `<div style="display:flex;gap:6px;margin-bottom:6px">
    <button class="implied-tog on" onclick="rndDetailView(this,'f','${r.id}')" id="rdd-f-${r.id}">F9</button>
    <button class="implied-tog" onclick="rndDetailView(this,'b','${r.id}')" id="rdd-b-${r.id}">B9</button>
    <button class="implied-tog" onclick="rndDetailView(this,'a','${r.id}')" id="rdd-a-${r.id}">All</button>
  </div>
  <div id="rdd-front-${r.id}" style="overflow-x:auto">${tbl(front,true,'OUT')}</div>
  <div id="rdd-back-${r.id}" style="display:none;overflow-x:auto">${tbl(back,true,'IN')}</div>
  <div id="rdd-all-${r.id}" style="display:none;overflow-x:auto">${allTbl}</div>`;
}

function rndToggleDetail(id){
  const el=document.getElementById('rnd-detail-'+id);
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function rndToggleLink(id){
  const el=document.getElementById('rnd-link-'+id);
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function rndDetailView(btn,view,id){
  document.getElementById('rdd-front-'+id).style.display=view==='f'?'block':'none';
  document.getElementById('rdd-back-'+id).style.display=view==='b'?'block':'none';
  document.getElementById('rdd-all-'+id).style.display=view==='a'?'block':'none';
  document.getElementById('rdd-f-'+id)?.classList.toggle('on',view==='f');
  document.getElementById('rdd-b-'+id)?.classList.toggle('on',view==='b');
  document.getElementById('rdd-a-'+id)?.classList.toggle('on',view==='a');
}

function rndSaveLinks(id){
  const r=rounds.find(x=>x.id===id); if(!r) return;
  r.sessionIds=[...document.querySelectorAll(`.rnd-link-chk[data-rid="${id}"]:checked`)].map(el=>el.value);
  save(); renderHandicap();
}

function updateRound(id, field, val) {
  const r = rounds.find(x=>x.id===id); if(!r) return;
  r[field] = val;
  if(['score','rating','slope'].includes(field)) {
    r.diff = calcDiff(r.score, r.rating, r.slope);
    const el = document.getElementById('rdiff-'+id);
    if(el) el.textContent = r.diff!==null ? r.diff : '\u2014';
  }
  save();
  const hcp = getHandicap();
  const hcpEl = document.getElementById('hcpNum');
  if(hcpEl) { hcpEl.textContent = hcp!==null?hcp:'\u2014'; }
  const n=rounds.length;
  const take=n>=20?8:n>=17?7:n>=15?6:n>=12?5:n>=10?4:n>=9?3:n>=7?2:1;
  const metaEl = document.getElementById('hcpMeta');
  if(metaEl) metaEl.textContent = hcp!==null?`${n} round${n!==1?'s':''} \u00B7 best ${Math.min(take,n)} differentials \u00B7 WHS formula`:'Log a round to calculate';
}

function toggleRoundMode(){
  const btn=document.getElementById('rModeBtn');
  const grid=document.getElementById('rHoleGrid');
  if(!btn||!grid) return;
  const on=btn.classList.toggle('on');
  btn.textContent=on?'Detailed':'Simple';
  grid.style.display=on?'block':'none';
  if(on) _buildRoundHoleGrid();
}

function _buildRoundHoleGrid(){
  const grid=document.getElementById('rHoleGrid');
  if(!grid) return;
  let parMap={}, ydsMap={};
  const csel=document.getElementById('rCourseSelect')?.value||'';
  if(csel&&csel!=='__manual__'){
    const course=courses.find(c=>c.id===csel);
    const teeId=document.getElementById('rTeeSelect')?.value||'';
    const tee=course?.tees?.find(t=>t.id===teeId)||course?.tees?.[0];
    if(tee?.holes) tee.holes.forEach(h=>{parMap[h.number]=h.par; ydsMap[h.number]=h.yards||'';});
  }
  const makeRow=(n)=>{
    const par=parMap[n]||'';
    const yds=ydsMap[n]||'';
    const parN=parseInt(par)||0;
    const cls=parN===3?'par3-row':parN===5?'par5-row':'';
    return `<tr class="rnd-hole-row ${cls}" data-hole="${n}" data-par="${par}" data-yards="${yds}">
      <td style="color:var(--tx3);font-size:.55rem;min-width:20px;font-weight:600">${n}</td>
      <td style="color:var(--tx3);font-size:.6rem;text-align:center">${par||'\u2014'}</td>
      <td style="color:var(--tx3);font-size:.6rem;text-align:center">${yds||'\u2014'}</td>
      <td><input class="rnd-hole-inp rh-score" placeholder="\u2014" inputmode="numeric" style="width:30px"></td>
      <td><input class="rnd-hole-inp rh-putts" placeholder="\u2014" inputmode="numeric" style="width:30px"></td>
      <td><button class="rnd-gir-btn" data-gir="" onclick="rndGirCycle(this)">\u2014</button></td>
      <td><input class="rnd-hole-inp rh-notes" placeholder="" style="width:56px;text-align:left"></td>
    </tr>`;
  };
  const subRow=(lbl)=>`<tr class="subtotal-row">
    <td class="sub-lbl" colspan="3" style="text-align:right;padding-right:6px">${lbl}</td>
    <td id="sub-score-${lbl.toLowerCase()}" style="text-align:center">\u2014</td>
    <td id="sub-putts-${lbl.toLowerCase()}" style="text-align:center">\u2014</td>
    <td id="sub-gir-${lbl.toLowerCase()}" style="text-align:center">\u2014</td>
    <td></td>
  </tr>`;
  const rows=Array.from({length:18},(_,i)=>i+1).map(n=>{
    const row=makeRow(n);
    if(n===9)  return row+subRow('OUT');
    if(n===18) return row+subRow('IN')+subRow('TOTAL');
    return row;
  }).join('');
  grid.innerHTML=`
    <div style="display:flex;gap:5px;margin-bottom:6px;align-items:center">
      <span style="font-size:.6rem;color:var(--tx3);text-transform:uppercase;letter-spacing:.07em">Hole detail</span>
      <button class="implied-tog on" id="hgv-f" onclick="rndGridView('f')">F9</button>
      <button class="implied-tog" id="hgv-b" onclick="rndGridView('b')">B9</button>
      <button class="implied-tog" id="hgv-a" onclick="rndGridView('a')">All</button>
    </div>
    <div style="overflow-x:auto">
      <table class="rnd-hole-tbl">
        <thead><tr><th>H</th><th>Par</th><th>Yds</th><th>Score</th><th>Putts</th><th>GIR</th><th style="text-align:left">Notes</th></tr></thead>
        <tbody id="rndHoleRows">${rows}</tbody>
      </table>
    </div>`;
  rndGridView('f');
  document.querySelectorAll('.rh-score, .rh-putts, .rnd-gir-btn').forEach(el=>{
    el.addEventListener(el.tagName==='BUTTON'?'click':'input', _updateRndSubtotals);
  });
}

function _updateRndSubtotals(){
  const rows=[...document.querySelectorAll('.rnd-hole-row')];
  const sum=(rs,sel)=>rs.reduce((t,r)=>{const v=parseInt(r.querySelector(sel)?.value||'');return t+(isNaN(v)?0:v);},0);
  const girCount=(rs)=>rs.reduce((t,r)=>{const b=r.querySelector('.rnd-gir-btn');return t+(b?.dataset.gir==='Y'?1:0);},0);
  const front=rows.filter(r=>+r.dataset.hole<=9);
  const back=rows.filter(r=>+r.dataset.hole>=10&&+r.dataset.hole<=18);
  const fmt=(v,rs,sel)=>rs.some(r=>r.querySelector(sel)?.value?.trim())?v||0:'\u2014';
  const fmtG=(v,rs)=>rs.some(r=>r.querySelector('.rnd-gir-btn')?.dataset.gir)?v:'\u2014';
  const fs=sum(front,'.rh-score'),fp=sum(front,'.rh-putts'),fg=girCount(front);
  const bs=sum(back,'.rh-score'),bp=sum(back,'.rh-putts'),bg=girCount(back);
  const el=id=>document.getElementById(id);
  if(el('sub-score-out'))  el('sub-score-out').textContent =fmt(fs,front,'.rh-score');
  if(el('sub-putts-out'))  el('sub-putts-out').textContent =fmt(fp,front,'.rh-putts');
  if(el('sub-gir-out'))    el('sub-gir-out').textContent   =fmtG(fg,front);
  if(el('sub-score-in'))   el('sub-score-in').textContent  =fmt(bs,back,'.rh-score');
  if(el('sub-putts-in'))   el('sub-putts-in').textContent  =fmt(bp,back,'.rh-putts');
  if(el('sub-gir-in'))     el('sub-gir-in').textContent    =fmtG(bg,back);
  const hasAny=[...rows].some(r=>r.querySelector('.rh-score')?.value?.trim());
  if(el('sub-score-total')) el('sub-score-total').textContent=hasAny?fs+bs:'\u2014';
  if(el('sub-putts-total')) el('sub-putts-total').textContent=(front.some(r=>r.querySelector('.rh-putts')?.value?.trim())||back.some(r=>r.querySelector('.rh-putts')?.value?.trim()))?fp+bp:'\u2014';
  if(el('sub-gir-total'))   el('sub-gir-total').textContent  =(front.some(r=>r.querySelector('.rnd-gir-btn')?.dataset.gir)||back.some(r=>r.querySelector('.rnd-gir-btn')?.dataset.gir))?fg+bg:'\u2014';
}

function rndGridView(v){
  const rows=document.querySelectorAll('.rnd-hole-row');
  rows.forEach(r=>{
    const n=parseInt(r.dataset.hole);
    r.style.display=(v==='f'&&n<=9)||(v==='b'&&n>=10)||(v==='a')?'':'none';
  });
  const subOut=document.getElementById('sub-score-out')?.closest('tr');
  const subIn=document.getElementById('sub-score-in')?.closest('tr');
  const subTot=document.getElementById('sub-score-total')?.closest('tr');
  if(subOut)  subOut.style.display =(v==='f'||v==='a')?'':'none';
  if(subIn)   subIn.style.display  =(v==='b'||v==='a')?'':'none';
  if(subTot)  subTot.style.display =(v==='a')?'':'none';
  ['f','b','a'].forEach(x=>document.getElementById('hgv-'+x)?.classList.toggle('on',x===v));
}

function rndGirCycle(btn){
  const cur=btn.dataset.gir;
  const next=cur===''?'Y':cur==='Y'?'N':'';
  btn.dataset.gir=next;
  btn.textContent=next||'\u2014';
  btn.className='rnd-gir-btn'+(next==='Y'?' on-y':next==='N'?' on-n':'');
  _updateRndSubtotals();
}

function toggleRndLinker(){
  const el=document.getElementById('rSessLinker');
  const chev=document.getElementById('rSessChev');
  if(!el) return;
  const on=el.style.display==='none';
  el.style.display=on?'block':'none';
  if(chev) chev.textContent=on?'\u25B2':'\u25BC';
  if(on) _buildRndLinker();
}

function _buildRndLinker(){
  const el=document.getElementById('rSessLinkerList');
  if(!el) return;
  const csel=document.getElementById('rCourseSelect')?.value||'';
  const courseName=csel&&csel!=='__manual__'
    ? (courses.find(c=>c.id===csel)?.name||'').toLowerCase()
    : (document.getElementById('rCourse')?.value||'').toLowerCase();
  const matching=history.filter(h=>(h.type==='manual'||h.type==='optimisation'||h.type==='caddie'||h.type==='both')
    &&(h.course||'').toLowerCase().split(' ').some(w=>w.length>2&&courseName.includes(w)));
  if(!matching.length){el.innerHTML='<div style="font-size:.62rem;color:var(--tx3)">No sessions for this course yet.</div>';return;}
  el.innerHTML=matching.map(s=>{
    const ico=s.type==='manual'?'\u270F\uFE0F':'\uD83E\uDD16';
    return `<label style="display:flex;align-items:center;gap:6px;font-size:.62rem;color:var(--tx2);padding:2px 0;cursor:pointer"><input type="checkbox" class="rnd-sess-chk" value="${s.id}"> ${ico} ${fmtDate(s.date)} \u00B7 ${escHtml(s.course||'')} (${escHtml(s.tee||'')})</label>`;
  }).join('');
}

function exportRoundTask(){
  const taskText=getRoundTaskText();
  const ver=(taskText.match(/RoundTaskVersion:\s*(\d+)/)||[])[1]||'?';
  const csel=document.getElementById('rCourseSelect')?.value||'';
  const course=csel&&csel!=='__manual__'?courses.find(c=>c.id===csel):null;
  let courseSection='# No course selected \u2014 user can specify verbally.';
  if(course){
    courseSection=`COURSE | ${course.name} | Par ${course.par||'?'}`;
    const teeId=document.getElementById('rTeeSelect')?.value||'';
    const tee=course.tees?.find(t=>t.id===teeId)||course.tees?.[0];
    if(tee){
      courseSection+=`\nTEE | ${tee.name} | Rating ${tee.rating} | Slope ${tee.slope}`;
      if(tee.holes?.length) tee.holes.forEach(h=>{courseSection+=`\nHOLE | ${h.number} | Par ${h.par} | ${h.yards||'?'}y`;});
    }
  }
  const hcp=getHandicap();
  const content=`=== VIRTUAL CADDIE TASK ===\nTaskType: log-round\nDate: ${today()}\nAppVersion: ${APP_VERSION}\nRoundTaskVersion: ${ver}\n\n--- TASK INSTRUCTIONS ---\n${taskText}\n\n--- USER DATA ---\nHANDICAP | ${hcp!==null?hcp:'Not set'}\n${courseSection}\n\n=== EXISTING SESSIONS ===\n${history.filter(h=>h.type==='manual'||h.type==='optimisation'||h.type==='caddie'||h.type==='both').slice(0,10).map(h=>`SESSION_ID | ${h.id} | ${fmtDate(h.date)} | ${h.type} | ${h.course||''} (${h.tee||''})`).join('\n')||'# No sessions yet.'}`;
  downloadTask(`vc-round-task-${today()}.txt`, content);
}

function exportProfilePdf() {
  const hcp     = getHandicap();
  const name    = profile.name || 'Golfer';
  const handed  = profile.handed || '';
  const gender  = profile.gender || '';
  const homeCourse = profile.homeCourseId
    ? (courses.find(c=>c.id===profile.homeCourseId)?.name || profile.homeClub || '')
    : (profile.homeClub || '');

  function hcpTrend() {
    if(rounds.length < 5) return {label:'Not enough rounds', arrow:'', color:'#8a9e82'};
    const sorted = [...rounds].sort((a,b)=>b.date.localeCompare(a.date));
    const calc = arr => {
      const diffs = arr.map(r=>r.diff).filter(d=>d!==null&&d!==undefined).sort((a,b)=>a-b);
      if(!diffs.length) return null;
      const take = Math.min(4, diffs.length);
      return Math.round(diffs.slice(0,take).reduce((a,b)=>a+b,0)/take*0.96*10)/10;
    };
    const recent = calc(sorted.slice(0,8));
    const prior  = calc(sorted.slice(8,16));
    if(recent===null||prior===null) return {label:'Improving', arrow:'\u2193', color:'#3d6b35'};
    const diff = recent - prior;
    if(diff < -0.5) return {label:'Improving',  arrow:'\u2193', color:'#3d6b35'};
    if(diff >  0.5) return {label:'Rising',     arrow:'\u2191', color:'#a03030'};
    return              {label:'Stable',      arrow:'\u2192', color:'#9a7a2a'};
  }
  const trend = hcpTrend();

  const activeBag = bag
    .filter(c=>c.type!=='Putter'&&c.tested&&(c.sessions||[]).length>0)
    .sort((a,b)=>{
      const order=['Driver','Fairway Wood','Hybrid','Iron','Wedge','Chipper'];
      return (order.indexOf(a.type)||99)-(order.indexOf(b.type)||99);
    });
  const bagRows = activeBag.map(c=>{
    const stats = deriveStats(c.sessions);
    const imp   = stats ? calcImplied(stats,c) : null;
    const rng   = imp ? `${imp.impMin}\u2013${imp.impMax}` : (stats ? `${stats.avgMin}\u2013${stats.avgMax}` : '\u2014');
    const {type:tl} = getTypeLabel(c);
    return `<tr><td>${tl}</td><td>${c.model||c.brand||''}</td><td style="text-align:right">${rng} yds</td></tr>`;
  }).join('');

  const courseRows = [...courses]
    .sort((a,b)=>{
      if(a.id===profile.homeCourseId) return -1;
      if(b.id===profile.homeCourseId) return 1;
      return (a.name||'').localeCompare(b.name||'');
    })
    .map(c=>{
      const isHome = c.id===profile.homeCourseId;
      return `<tr><td>${isHome?'\uD83C\uDFE0 ':''}<strong>${c.name||'\u2014'}</strong></td><td>${c.city||''}</td><td style="text-align:right">Par ${c.par} \u00B7 ${c.yardage||'?'} yds</td></tr>`;
    }).join('');

  const recentRounds = [...rounds].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  const bestDiff = rounds.length ? Math.min(...rounds.map(r=>r.diff).filter(d=>d!==null)) : null;
  const roundRows = recentRounds.map(r=>
    `<tr><td>${r.date}</td><td>${r.courseName||'\u2014'}</td><td style="text-align:right">${r.score||'\u2014'}</td><td style="text-align:right;color:#9a7a2a">${r.diff!==null?r.diff:'\u2014'}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Virtual Caddie \u2014 ${escHtml(name)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Mono',monospace,sans-serif;background:#f4efe6;color:#2c3a28;padding:32px;max-width:720px;margin:0 auto;}
  @media print{body{background:#fff;padding:16px;}}
  .card{background:#fff;border:1px solid #ddd5c4;border-radius:8px;padding:18px;margin-bottom:14px;}
  .hero{background:linear-gradient(135deg,#e8f0e5,#fff);border:2px solid #3d6b35;border-radius:10px;padding:24px;margin-bottom:16px;display:flex;align-items:center;gap:20px;}
  .avatar{width:60px;height:60px;border-radius:50%;background:#3d6b35;color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.6rem;font-weight:700;flex-shrink:0;}
  .hero-name{font-size:1.5rem;font-weight:700;color:#2d5127;letter-spacing:-.01em;}
  .hero-sub{font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;color:#8a9e82;margin-top:3px;}
  .hero-hcp{text-align:right;flex-shrink:0;}
  .hcp-num{font-size:3rem;font-weight:700;color:#2d5127;line-height:1;}
  .hcp-lbl{font-size:.55rem;letter-spacing:.14em;text-transform:uppercase;color:#8a9e82;}
  .trend{font-size:.72rem;margin-top:4px;}
  h3{font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8a9e82;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #ddd5c4;}
  table{width:100%;border-collapse:collapse;font-size:.72rem;}
  td{padding:4px 6px;border-bottom:1px solid #f0ebe0;}
  tr:last-child td{border-bottom:none;}
  .footer{text-align:center;font-size:.56rem;color:#8a9e82;margin-top:20px;letter-spacing:.1em;text-transform:uppercase;}
  .meta{font-size:.65rem;color:#5a6e52;margin-bottom:12px;}
</style>
</head><body>
<div class="hero">
  <div class="avatar">${escHtml(name.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'\u26F3')}</div>
  <div style="flex:1">
    <div class="hero-name">${escHtml(name)}</div>
    <div class="hero-sub">${[handed,gender,homeCourse?'Home: '+homeCourse:''].filter(Boolean).join(' \u00B7 ')}</div>
  </div>
  <div class="hero-hcp">
    <div class="hcp-num">${hcp!==null?hcp:'\u2014'}</div>
    <div class="hcp-lbl">Handicap Index</div>
    <div class="trend" style="color:${trend.color}">${trend.arrow} ${trend.label}</div>
  </div>
</div>

${activeBag.length ? `
<div class="card">
  <h3>Active Bag \u2014 ${activeBag.length} clubs</h3>
  <table><tbody>${bagRows}</tbody></table>
</div>` : ''}

${courses.length ? `
<div class="card">
  <h3>Courses \u2014 ${courses.length} saved</h3>
  <table><tbody>${courseRows}</tbody></table>
</div>` : ''}

${rounds.length ? `
<div class="card">
  <h3>Round History</h3>
  <div class="meta">Best differential: <strong>${bestDiff!==null?bestDiff:'\u2014'}</strong> \u00B7 ${rounds.length} round${rounds.length!==1?'s':''} logged</div>
  <table>
    <thead><tr style="font-size:.6rem;color:#8a9e82;text-transform:uppercase;letter-spacing:.08em">
      <td>Date</td><td>Course</td><td style="text-align:right">Score</td><td style="text-align:right">Diff</td>
    </tr></thead>
    <tbody>${roundRows}</tbody>
  </table>
</div>` : ''}

<div class="footer">Gordy the Virtual Caddy \u00B7 Generated ${fmtDate(today())}</div>
<script>window.onload=()=>window.print();<\/script>
</body></html>`;

  const blob = new Blob([html], {type:'text/html'});
  const url  = URL.createObjectURL(blob);
  const w    = window.open(url, '_blank');
  if(w) w.onunload = () => URL.revokeObjectURL(url);
  else  URL.revokeObjectURL(url);
}

export {
  renderHandicap, onRoundCourseSelect, onRoundTeeSelect, updateDiffPreview,
  addRound, deleteRound, updateRound, toggleRndSection, rndRegenPdf,
  _rndLinkHTML, _rndDetailHTML, rndToggleDetail, rndToggleLink, rndDetailView,
  rndSaveLinks, toggleRoundMode, _buildRoundHoleGrid, _updateRndSubtotals,
  rndGridView, rndGirCycle, toggleRndLinker, _buildRndLinker,
  exportRoundTask, exportProfilePdf
};

Object.assign(window, {
  renderHandicap, onRoundCourseSelect, onRoundTeeSelect, updateDiffPreview,
  addRound, deleteRound, confirmDeleteRound, updateRound, toggleRndSection, rndRegenPdf,
  rndToggleDetail, rndToggleLink, rndDetailView, rndSaveLinks,
  toggleRoundMode, rndGridView, rndGirCycle, toggleRndLinker,
  exportRoundTask, exportProfilePdf
});
Object.assign(window, { addRound, exportProfilePdf, exportRoundTask, onRoundCourseSelect, onRoundTeeSelect, toggleRndLinker, toggleRndSection, toggleRoundMode, updateDiffPreview });
