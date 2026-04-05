import { deriveStats, calcImplied, fmtDate } from './geo.js';
import { CLUB_VARIANTS, TYPE_COLOR, BRANDS, STIFFNESS, CLUB_TYPES } from './constants.js';
import { bag, profile, today, uid, save, setBag } from './store.js';

export function getVariantDefault(type, variantId) {
  return (CLUB_VARIANTS[type]||[]).find(v=>v.id===variantId)||null;
}

export function getYardLabel(c) {
  const t = c.yardType || profile.yardType || 'Total';
  return t;
}

export function getTypeLabel(club) {
  const id=(club.identifier||'').trim(), t=club.type;
  if(t==='Driver') return {type:'Driver',loft:id.match(/[\d.]+\u00B0/)?id.match(/[\d.]+\u00B0/)[0]:''};
  if(t==='Fairway Wood'){const n=id.match(/(\d+)[Ww]/);return{type:n?n[1]+'W':'FW',loft:id.match(/[\d.]+\u00B0/)?id.match(/[\d.]+\u00B0/)[0]:''};}
  if(t==='Hybrid'){const n=id.match(/(\d+)[Hh]/);return{type:n?n[1]+'H':'HYB',loft:id.match(/[\d.]+\u00B0/)?id.match(/[\d.]+\u00B0/)[0]:''};}
  if(t==='Iron'){const n=id.match(/^(\d+)/);return{type:n?n[1]+'I':'IRN',loft:''};}
  if(t==='Wedge'){const nm=id.match(/^(PW|GW|SW|LW|AW)/i);if(nm)return{type:nm[1].toUpperCase(),loft:id.match(/[\d.]+\u00B0/)?id.match(/[\d.]+\u00B0/)[0]:''};const d=id.match(/([\d.]+)\u00B0/);return{type:d?d[1]+'\u00B0':'WDG',loft:''};}
  if(t==='Putter') return{type:'PUT',loft:''};
  return{type:t.slice(0,3).toUpperCase(),loft:''};
}

export function clubDetailMode() { return localStorage.getItem('vc:clubMode')!=='simple'; }

export function toggleClubMode() {
  const next = !clubDetailMode();
  localStorage.setItem('vc:clubMode', next?'detailed':'simple');
  const btn = document.getElementById('clubModeBtn');
  if(btn) btn.textContent = next ? 'Detailed' : 'Simple';
  renderClubs();
}

export function variantOptions(type, selected) {
  const variants = CLUB_VARIANTS[type]||[];
  if(!variants.length) return '<option value="">--</option>';
  return variants.map(v=>`<option value="${v.id}" ${v.id===selected?'selected':''}>${v.id}</option>`).join('');
}

export function onTypeChange(id, val) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  c.type = val;
  const variants = CLUB_VARIANTS[val]||[];
  if(variants.length) {
    c.identifier = variants[0].id;
    if(!c.shaftLength) c.shaftLength = String(variants[0].shaft);
    if(!c.stiffness || c.stiffness==='Regular') c.stiffness = variants[0].stiffness;
  }
  save(); renderClubs();
  setTimeout(()=>{ const p=document.getElementById('cpanel-'+id); if(p){p.style.display='block';const r=document.getElementById('crow-'+id);r?.classList.add('open');const btn=r?.querySelector('.expbtn');if(btn)btn.textContent='\u25B2';}},50);
}

export function onVariantChange(id, val) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  c.identifier = val;
  const def = getVariantDefault(c.type, val);
  if(def) {
    c.shaftLength = String(def.shaft);
    c.stiffness = def.stiffness;
  }
  save();
  const {type:tl,loft} = getTypeLabel(c);
  const dot = TYPE_COLOR[c.type]||'#555';
  const blk = document.querySelector(`#crow-${id} .ctblk`);
  if(blk){blk.style.background=dot+'1a';blk.style.borderRightColor=dot+'44';const ll=blk.querySelector('.cloftlbl');if(loft){if(ll)ll.textContent=loft;else{const d=document.createElement('div');d.className='cloftlbl';d.textContent=loft;blk.appendChild(d);}}else if(ll)ll.remove();}
  const vsel = document.querySelector(`#cpanel-${id} .variant-sel`);
  if(vsel) vsel.value = val;
  if(def) {
    const loftInput = document.querySelector(`#cpanel-${id} input[onchange*="'loft'"]`);
    if(loftInput) loftInput.value = def.loft + '\u00B0';
  }
}

export function addSessionSimple(id) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  const mx = parseInt(document.getElementById('smaxs-'+id)?.value||'0');
  if(!mx) return;
  const mn = Math.max(0, mx - 20);
  const dt = document.getElementById('sds-'+id)?.value||today();
  c.sessions = [{id:uid(),date:dt,min:String(mn),max:String(mx)},...(c.sessions||[])].sort((a,b)=>b.date.localeCompare(a.date));
  save(); renderClubs();
  setTimeout(()=>{ const p=document.getElementById('cpanel-'+id); if(p){p.style.display='block';const r=document.getElementById('crow-'+id);r?.classList.add('open');const btn=r?.querySelector('.expbtn');if(btn)btn.textContent='\u25B2';}},50);
}

export function showImplied() { return localStorage.getItem('vc:showImplied')==='1'; }

export function toggleImplied() {
  const next = !showImplied();
  localStorage.setItem('vc:showImplied', next?'1':'0');
  const btn = document.getElementById('impliedTogBtn');
  const lbl = document.getElementById('impliedTogLbl');
  if(btn) btn.classList.toggle('on', next);
  if(lbl) lbl.textContent = next?'On':'Off';
  renderClubs();
}

export function renderClubs() {
  const playing = bag.filter(c=>c.type!=='Putter');
  const putter  = bag.find(c=>c.type==='Putter');
  document.getElementById('clubsBadge').textContent = bag.length;
  const on = showImplied();
  const iBtn = document.getElementById('impliedTogBtn');
  const lbl  = document.getElementById('impliedTogLbl');
  if(iBtn) iBtn.classList.toggle('on', on);
  if(lbl)  lbl.textContent = on?'On':'Off';
  const mBtn = document.getElementById('clubModeBtn');
  if(mBtn) { mBtn.textContent = clubDetailMode()?'Detailed':'Simple'; mBtn.classList.toggle('on', clubDetailMode()); }
  document.getElementById('clubList').innerHTML = playing.length
    ? playing.map(c=>clubRowHTML(c,false)).join('')
    : '<div class="hist-empty">No clubs yet. Use \uFF0B Add Club or tap \uD83E\uDD16 Get AI Help to build your bag.</div>';
  document.getElementById('putterSlot').innerHTML = putter
    ? clubRowHTML(putter, true)
    : '<button class="add-club-btn" style="margin-top:6px" onclick="addPutter()">\uFF0B Add Putter</button>';
}

export function clubRowHTML(c, isPutter) {
  const {type:tl,loft} = getTypeLabel(c);
  const dot = TYPE_COLOR[c.type]||'#555';
  const stats = deriveStats(c.sessions);
  const inc = isPutter?false:!!c.tested;
  const implied = (!isPutter&&stats) ? calcImplied(stats,c) : null;
  const yLbl = getYardLabel(c);
  const rawRange = stats ? (stats.avgMin&&stats.avgMax?stats.avgMin+'-'+stats.avgMax:stats.avgMax?'<='+stats.avgMax:stats.avgMin+'+') : null;
  const impRange = implied ? implied.impMin+'-'+implied.impMax : null;
  const impTag   = (showImplied()&&implied&&implied.adjusted)
    ? `<span class="imp-badge adj" title="${implied.reason}">implied ${impRange} yds</span>` : '';
  const yardBadge = `<span class="yard-badge">${yLbl}</span>`;
  const distHTML = stats
    ? `<div class="cdist">${rawRange} yds ${yardBadge}${impTag}</div><div class="csess">${stats.count} session${stats.count!==1?'s':''} / ${fmtDate(stats.lastDate)}</div>`
    : `<div class="cnodata">No sessions -- tap expand to add</div>`;
  const sessHTML = (c.sessions||[]).map(s=>`
    <div class="sess-row">
      <input class="sess-edit" type="date" value="${s.date}" onchange="updateSession('${c.id}','${s.id}','date',this.value)">
      <input class="sess-edit" type="text" inputmode="numeric" value="${s.min}" placeholder="min" onchange="updateSession('${c.id}','${s.id}','min',this.value)" style="width:54px">
      <span style="font-size:.65rem;color:var(--tx3)">-</span>
      <input class="sess-edit" type="text" inputmode="numeric" value="${s.max}" placeholder="max" onchange="updateSession('${c.id}','${s.id}','max',this.value)" style="width:54px">
      <span style="font-size:.62rem;color:var(--tx3)">yds</span>
      <input class="sess-edit" type="text" value="${s.notes||''}" placeholder="note..." onchange="updateSession('${c.id}','${s.id}','notes',this.value)" style="flex:1;min-width:60px">
      <button class="sess-del" onclick="deleteClubSession('${c.id}','${s.id}')">x</button>
    </div>`).join('');

  const simple   = !clubDetailMode() && !isPutter;
  const brands   = BRANDS.map(b=>`<option ${b===c.brand?'selected':''}>${b}</option>`).join('');
  const stiffs   = STIFFNESS.map(s=>`<option ${s===c.stiffness?'selected':''}>${s}</option>`).join('');
  const variants = variantOptions(c.type, c.identifier||'');
  const typeOptsAll      = CLUB_TYPES.map(t=>`<option ${t===c.type?'selected':''}>${t}</option>`).join('');
  const typeOptsNoPutter = CLUB_TYPES.filter(t=>t!=='Putter').map(t=>`<option ${t===c.type?'selected':''}>${t}</option>`).join('');
  const confOpts = [5,4,3,2,1].map(n=>`<option value="${n}" ${(c.confidence??4)==n?'selected':''}>${n} - ${{5:'Highest',4:'Baseline',3:'Moderate',2:'Low',1:'Least'}[n]}</option>`).join('');
  const biasOpts = ['Straight','Draw','Hook','Fade','Slice','Push Right','Push Left'].map(b=>`<option ${(c.bias||'Straight')===b?'selected':''}>${b}</option>`).join('');
  const yardOpts = `<option value="" ${!c.yardType?'selected':''}>Global (${profile.yardType||'Total'})</option><option ${c.yardType==='Total'?'selected':''}>Total</option><option ${c.yardType==='Carry'?'selected':''}>Carry</option>`;

  const simplePanel = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div class="sf"><div class="sf-lbl">Type</div>
        <select class="type-sel" onchange="onTypeChange('${c.id}',this.value)">${typeOptsNoPutter}</select>
      </div>
      <div class="sf"><div class="sf-lbl">Variant</div>
        <select class="variant-sel" onchange="onVariantChange('${c.id}',this.value)">${variants}</select>
      </div>
    </div>
    <div class="add-sess" style="margin-bottom:8px">
      <div class="asf"><label>Date</label><input type="date" id="sds-${c.id}" value="${today()}"></div>
      <div class="asf"><label>Max yds</label><input type="text" inputmode="numeric" id="smaxs-${c.id}" placeholder="160" style="width:84px"></div>
      <button class="btn" onclick="addSessionSimple('${c.id}')">+ Log</button>
    </div>
    <div style="font-size:.6rem;color:var(--tx3);margin-bottom:6px">Min = max - 20 yds. Switch to Detailed to set independently.</div>
    ${!c.sessions?.length?'<div style="font-size:.65rem;color:var(--tx3)">No sessions yet.</div>':''}
    ${sessHTML}`;

  const detailedPanel = `
    <div class="specs">
      <div class="sf"><div class="sf-lbl">Brand</div><select onchange="updateClub('${c.id}','brand',this.value)">${brands}</select></div>
      <div class="sf"><div class="sf-lbl">Type</div>
        <select class="type-sel" onchange="onTypeChange('${c.id}',this.value)">${typeOptsAll}</select>
      </div>
      <div class="sf"><div class="sf-lbl">Variant</div>
        <select class="variant-sel" onchange="onVariantChange('${c.id}',this.value)">${variants}</select>
      </div>
      <div class="sf"><div class="sf-lbl">Loft</div><input value="${(()=>{const d=getVariantDefault(c.type,c.identifier||'');return d?d.loft+'\u00B0':c.loft||'';})()}" placeholder="e.g. 34\u00B0" onchange="updateClub('${c.id}','loft',this.value)"></div>
      <div class="sf"><div class="sf-lbl">Model</div><input value="${c.model||''}" placeholder="e.g. SIM 2 Max" onchange="updateClub('${c.id}','model',this.value)"></div>
      <div class="sf"><div class="sf-lbl">Stiffness</div><select onchange="updateClub('${c.id}','stiffness',this.value)">${stiffs}</select></div>
      <div class="sf"><div class="sf-lbl">Length (in)</div><input value="${c.shaftLength||''}" placeholder="45.75" onchange="updateClub('${c.id}','shaftLength',this.value)"></div>
      <div class="sf"><div class="sf-lbl">Confidence</div><select onchange="updateClub('${c.id}','confidence',this.value)">${confOpts}</select></div>
      <div class="sf"><div class="sf-lbl">Bias</div><select onchange="updateClub('${c.id}','bias',this.value)">${biasOpts}</select></div>
      <div class="sf"><div class="sf-lbl">Yard Type</div><select onchange="updateClub('${c.id}','yardType',this.value)">${yardOpts}</select></div>
    </div>
    ${!isPutter?`
    <div class="sess-sec">
      <div class="sess-hdr"><span>Distance Sessions (${yLbl})</span>${stats?`<span>${stats.avgMin}-${stats.avgMax} yds avg${showImplied()&&implied&&implied.adjusted?' / implied '+implied.impMin+'-'+implied.impMax:''}</span>`:''}</div>
      ${!c.sessions?.length?'<div style="font-size:.65rem;color:var(--tx3);margin-bottom:6px">No sessions yet.</div>':''}
      ${sessHTML}
      <div class="add-sess">
        <div class="asf"><label>Date</label><input type="date" id="sd-${c.id}" value="${today()}"></div>
        <div class="asf"><label>Min yds</label><input type="text" inputmode="numeric" id="smin-${c.id}" placeholder="140" style="width:84px"></div>
        <div class="asf"><label>Max yds</label><input type="text" inputmode="numeric" id="smax-${c.id}" placeholder="160" style="width:84px"></div>
        <div class="asf"><label>Note</label><input type="text" id="snote-${c.id}" placeholder="optional..." style="width:120px"></div>
        <button class="btn" onclick="addSession('${c.id}')">+ Log</button>
      </div>
    </div>`:''}`;

  return `
  <div class="crow${inc?'':' excl'}" id="crow-${c.id}">
    <div class="cmain">
      <div class="ctblk" style="background:${dot}1a;border-right-color:${dot}44">
        <div class="ctlbl">${tl}</div>
        ${loft?`<div class="cloftlbl">${loft}</div>`:''}
      </div>
      <div class="cmid" onclick="toggleClub('${c.id}')">${distHTML}</div>
      <div class="cctrl">
        ${!isPutter?`<button class="activetog" title="Toggle Active/Retired" onclick="toggleActive('${c.id}')"><div class="activeicon ${inc?'on':'off'}">${inc?'Active':'Retired'}</div></button>`:''}
        <button class="expbtn" onclick="toggleClub('${c.id}')">&#9660;</button>
        <button class="delx" onclick="${isPutter?'replacePutter':'deleteClub'}('${c.id}')" title="${isPutter?'Remove putter':'Delete club'}">&#x2715;</button>
      </div>
    </div>
    <div class="cpanel" id="cpanel-${c.id}" style="display:none">
      ${simple ? simplePanel : detailedPanel}
    </div>
  </div>`;
}

export function toggleClub(id) {
  const panel = document.getElementById('cpanel-'+id);
  const crow  = document.getElementById('crow-'+id);
  const btn   = crow?.querySelector('.expbtn');
  if(!panel) return;
  const open = panel.style.display!=='none';
  panel.style.display = open?'none':'block';
  crow?.classList.toggle('open',!open);
  if(btn) btn.textContent = open?'\u25BC':'\u25B2';
}

export function toggleActive(id) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  c.tested = !c.tested;
  save(); renderClubs();
}

export function updateClub(id, field, val) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  c[field] = (field==='confidence') ? (parseInt(val)||4) : val;
  save();
  const {type:tl,loft} = getTypeLabel(c);
  const dot = TYPE_COLOR[c.type]||'#555';
  const blk = document.querySelector(`#crow-${id} .ctblk`);
  if(blk){blk.style.background=dot+'1a';blk.style.borderRightColor=dot+'44';const ll=blk.querySelector('.cloftlbl');if(loft){if(ll)ll.textContent=loft;else{const d=document.createElement('div');d.className='cloftlbl';d.textContent=loft;blk.appendChild(d);}}else if(ll)ll.remove();}
  if(['confidence','bias','yardType','loft'].includes(field)) {
    const stats = deriveStats(c.sessions);
    const implied = stats ? calcImplied(stats, c) : null;
    const yLbl = getYardLabel(c);
    const rawRange = stats ? (stats.avgMin&&stats.avgMax?stats.avgMin+'-'+stats.avgMax:stats.avgMax?'<='+stats.avgMax:stats.avgMin+'+') : null;
    const impRange = implied ? implied.impMin+'-'+implied.impMax : null;
    const impTag = (showImplied()&&implied&&implied.adjusted)
      ? `<span class="imp-badge adj" title="${implied.reason}">implied ${impRange} yds</span>` : '';
    const yardBadge = `<span class="yard-badge">${yLbl}</span>`;
    const mid = document.querySelector(`#crow-${id} .cmid`);
    const cdist = mid?.querySelector('.cdist');
    if(cdist && stats) cdist.innerHTML = `${rawRange} yds ${yardBadge}${impTag}`;
  }
}

export function addSession(id) {
  const c = bag.find(x=>x.id===id); if(!c) return;
  const dt    = document.getElementById('sd-'+id)?.value||today();
  const mn    = document.getElementById('smin-'+id)?.value||'';
  const mx    = document.getElementById('smax-'+id)?.value||'';
  const note  = document.getElementById('snote-'+id)?.value||'';
  if(!mn&&!mx) return;
  c.sessions = [{id:uid(),date:dt,min:mn,max:mx,notes:note},...(c.sessions||[])].sort((a,b)=>b.date.localeCompare(a.date));
  save(); renderClubs();
  setTimeout(()=>{ const p=document.getElementById('cpanel-'+id); if(p){p.style.display='block';const r=document.getElementById('crow-'+id);r?.classList.add('open');const btn=r?.querySelector('.expbtn');if(btn)btn.textContent='\u25B2';}},50);
}

export function updateSession(cid, sid, field, val) {
  const c = bag.find(x=>x.id===cid); if(!c) return;
  const s = c.sessions.find(x=>x.id===sid); if(!s) return;
  s[field] = val;
  save();
  const stats = deriveStats(c.sessions);
  const implied = stats ? calcImplied(stats,c) : null;
  const yLbl = getYardLabel(c);
  const rawRange = stats ? (stats.avgMin&&stats.avgMax?stats.avgMin+'-'+stats.avgMax:stats.avgMax?'<='+stats.avgMax:stats.avgMin+'+') : null;
  const impRange = implied ? implied.impMin+'-'+implied.impMax : null;
  const impTag = (showImplied()&&implied&&implied.adjusted)
    ? `<span class="imp-badge adj" title="${implied.reason}">implied ${impRange} yds</span>` : '';
  const yardBadge = `<span class="yard-badge">${yLbl}</span>`;
  const mid = document.querySelector(`#crow-${cid} .cmid`);
  if(mid&&stats) mid.querySelector('.cdist').innerHTML=`${rawRange} yds ${yardBadge}${impTag}`;
}

export function deleteClubSession(cid, sid) {
  const c = bag.find(x=>x.id===cid); if(!c) return;
  c.sessions = c.sessions.filter(s=>s.id!==sid);
  save(); renderClubs();
  setTimeout(()=>{ const p=document.getElementById('cpanel-'+cid); if(p){p.style.display='block';const r=document.getElementById('crow-'+cid);r?.classList.add('open');const btn=r?.querySelector('.expbtn');if(btn)btn.textContent='\u25B2';}},50);
}

export function deleteClub(id) { setBag(bag.filter(c=>c.id!==id)); save(); renderClubs(); }

export function addClub() {
  const simple = !clubDetailMode();
  const variants = CLUB_VARIANTS['Iron']||[];
  const def = variants[6]||variants[0]||null;
  const c = {
    id:uid(), brand:'', type:'Iron',
    identifier: def ? def.id : '',
    model: '',
    shaftLength: def ? String(def.shaft) : '',
    stiffness: def ? def.stiffness : 'Regular',
    confidence: simple ? 3 : 4,
    bias:'Straight', tested:true, sessions:[]
  };
  bag.push(c);
  save(); renderClubs();
  setTimeout(()=>{
    const p=document.getElementById('cpanel-'+c.id);
    if(p){p.style.display='block';const r=document.getElementById('crow-'+c.id);r?.classList.add('open');const btn=r?.querySelector('.expbtn');if(btn)btn.textContent='\u25B2';}
  },50);
}

export function _clubRange(activeClubs) {
  const order=['Driver','Fairway Wood','Hybrid','Iron','Wedge'];
  const sorted=activeClubs.slice().sort((a,b)=>order.indexOf(b.type)-order.indexOf(a.type));
  if(!sorted.length) return '';
  const short=c=>c.identifier||c.type.split(' ')[0];
  if(sorted.length===1) return short(sorted[0]);
  return short(sorted[sorted.length-1])+' - '+short(sorted[0]);
}

export function calcVizMaxRange() {
  const actives=bag.filter(c=>c.tested&&c.sessions?.length&&c.type!=='Putter');
  const maxes=actives.flatMap(c=>c.sessions.map(s=>+s.max)).filter(v=>v>0);
  if(!maxes.length) return 300;
  return Math.ceil(Math.max(...maxes)*1.2/10)*10.0;
}

export function addPutter() {
  bag.push({ id:uid(), brand:'', type:'Putter', identifier:'Putter', stiffness:'', shaftLength:'', tested:'PUTTER', confidence:4, bias:'Straight', yardType:'', loft:'', model:'', sessions:[] });
  save(); renderClubs();
}

export function replacePutter(id) {
  if(!confirm('Remove this putter? You can add a new one after.')) return;
  setBag(bag.filter(c=>c.id!==id)); save(); renderClubs();
}

Object.assign(window, {
  toggleClub, toggleActive, updateClub, addSession, updateSession,
  deleteClubSession, deleteClub, addClub, addPutter, replacePutter, toggleClubMode,
  onTypeChange, onVariantChange, addSessionSimple, toggleImplied, renderClubs,
  _clubRange, calcVizMaxRange
});
