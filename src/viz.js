import { calcVizMaxRange } from './clubs.js';
import { vizFlightKey, vizTierIdx, vizNormCdf, vizLightenHex, vizEllipsePath } from './geo.js';
import { VIZ_COLORS, VIZ_PATH_COLORS, VIZ_LP, VIZ_ASYM, VIZ_LPROB, VIZ_ROLL, FLIGHT_DATA, BIAS_DATA, ZONE_RING_RADII } from './constants.js';
import { vizGetDisp } from './dispersion.js';
import { bag, courses, history, profile, save, rangeSessions } from './store.js';

export let vizMode='coverage', vizDisplayMode='both', vizSelectedClubs=new Set();
export let vizSelectedHole=1, vizActiveCourse=null, vizActiveTee=null, vizInitDone=false, vizClubSrc='custom';
export let vizYardMode='total';
export let vizPaths=[[],[],[]]; // 3 paths, each = array of club IDs
export let vizPathVisible=[true,false,false];
export let vizHoleEdits={}; // scratchpad: hole number → {paths, visible} of club IDs
export let vizShotCount=1; // kept for legacy compat — path planner uses vizPaths directly
export let vizPlannerOpen=false;

export let vizDispSelectedSessions = new Set();
export let vizDispSelectedKeys     = new Set();
export let vizDispInitDone         = false;
export let vizDispYardageFilter    = {}; // clubId -> yardage number | null (null = All)

export function setVizInitDone(v) { vizInitDone = v; }
export function vizRenderEllipse(uid,cx,cy,rxR,rxL,ryU,ryD,tilt,hex,pR,pL,pS,pLn,mode){
  const ep=vizEllipsePath(cx,cy,rxR,rxL,ryU,ryD,tilt);
  const r=tilt*Math.PI/180,co=Math.cos(r),si=Math.sin(r);
  const rt=(x,y)=>{const dx=x-cx,dy=y-cy;return[cx+dx*co-dy*si,cy+dx*si+dy*co];};
  const[atX,atY]=rt(cx,cy-ryU-14),[abX,abY]=rt(cx,cy+ryD+14);
  const[mrX,mrY]=rt(cx+rxR+14,cy),[mlX,mlY]=rt(cx-rxL-14,cy);
  const rH=`M ${atX.toFixed(1)} ${atY.toFixed(1)} L ${atX+260} ${atY+260} L ${abX+260} ${abY+260} L ${abX.toFixed(1)} ${abY.toFixed(1)} Z`;
  const lH=`M ${atX.toFixed(1)} ${atY.toFixed(1)} L ${atX-260} ${atY-260} L ${abX-260} ${abY-260} L ${abX.toFixed(1)} ${abY.toFixed(1)} Z`;
  const sH=`M ${mlX.toFixed(1)} ${mlY.toFixed(1)} L ${mlX+220} ${mlY+220} L ${mrX+220} ${mrY+220} L ${mrX.toFixed(1)} ${mrY.toFixed(1)} Z`;
  const lnH=`M ${mlX.toFixed(1)} ${mlY.toFixed(1)} L ${mlX-220} ${mlY-220} L ${mrX-220} ${mrY-220} L ${mrX.toFixed(1)} ${mrY.toFixed(1)} Z`;
  const rv=parseInt(hex.slice(1,3),16),gv=parseInt(hex.slice(3,5),16),bv=parseInt(hex.slice(5,7),16);
  const oR=(0.12+pR*.38).toFixed(2),oL=(0.12+pL*.38).toFixed(2),oS=(0.10+pS*.22).toFixed(2),oLn=(0.08+pLn*.15).toFixed(2);
  let h=`<clipPath id="vcp${uid}"><path d="${ep}"/></clipPath>`;
  if(mode!=='prob') h+=`<path d="${ep}" fill="rgba(${rv},${gv},${bv},0.10)" stroke="${hex}" stroke-width="2"/>`;
  if(mode!=='shape') h+=`<g clip-path="url(#vcp${uid})"><path d="${rH}" fill="rgba(200,80,40,${oR})"/><path d="${lH}" fill="rgba(50,110,200,${oL})"/><path d="${sH}" fill="rgba(170,140,30,${oS})"/><path d="${lnH}" fill="rgba(50,110,200,${oLn})"/></g>`;
  return h;
}

// ── Core stacked canvas renderer ──────────────────────────────────────────────
export function vizDrawCanvas(dispList,fwYds,mode,title,subtitle,maxRange,interval){
  const svg=document.getElementById('vizSvg');
  const filtered=dispList.filter(d=>d&&d.carry>0).sort((a,b)=>b.carry-a.carry);
  if(!filtered.length){svg.innerHTML='<text x="220" y="260" text-anchor="middle" font-family="monospace" font-size="11" fill="#8a9e82">No session data for selected clubs</text>';return;}
  const W=440,PAD_T=48,PAD_B=72;
  const rangeTop=maxRange||calcVizMaxRange();
  const H=Math.min(Math.max(PAD_T+PAD_B+rangeTop*2.2,300),900);
  const scale=(H-PAD_T-PAD_B)/rangeTop;
  const cx=W/2,teeY=H-PAD_B,fwH=fwYds/2*scale,fwL=cx-fwH,fwR=cx+fwH;
  let defs='',shapes='',annots='';const legs=[],chips=[];
  filtered.forEach((d,i)=>{
    const carryY=teeY-d.carry*scale,aimX=cx+d.off*scale;
    const rxR=d.rxR*scale,rxL=d.rxL*scale,ryU=d.dl*scale,ryD=d.ds*scale,eCy=carryY+ryD*.1;
    const col=VIZ_COLORS[i%VIZ_COLORS.length];
    const es=vizRenderEllipse(i,aimX,eCy,rxR,rxL,ryU,ryD,d.tilt,col,d.pR,d.pL,d.pS,d.pLn,mode);
    defs+=es.match(/<clipPath[^>]*>.*?<\/clipPath>/s)?.[0]||'';
    shapes+=es.replace(/<clipPath[^>]*>.*?<\/clipPath>/s,'');
    if(i>0){const prev=filtered[i-1],gap=prev.carry-prev.ds-(d.carry+d.dl);
      if(gap>12){const gy=teeY-((prev.carry-prev.ds+d.carry+d.dl)/2)*scale;
        annots+=`<line x1="${cx-20}" y1="${gy}" x2="${cx+20}" y2="${gy}" stroke="rgba(160,48,48,.4)" stroke-width="1" stroke-dasharray="3 2"/><text x="${cx}" y="${gy+4}" font-family="monospace" font-size="8" fill="rgba(160,48,48,.7)" text-anchor="middle">gap ~${Math.round(gap)}y</text>`;}}
    const lx=Math.min(W-2,aimX+rxR+5);
    annots+=`<text x="${lx}" y="${eCy-3}" font-family="monospace" font-size="9" fill="${col}" font-weight="600">${escHtml(d.label)}</text><text x="${lx}" y="${eCy+9}" font-family="monospace" font-size="8" fill="rgba(44,58,40,.6)">${d.carry}y</text>`;
    annots+=`<line x1="${fwL-16}" y1="${carryY}" x2="${fwL-3}" y2="${carryY}" stroke="${col}" stroke-width="1" opacity=".8"/><text x="${fwL-18}" y="${carryY+4}" font-family="monospace" font-size="8" fill="${col}" text-anchor="end">${d.carry}y</text>`;
    const pFw=Math.max(0,Math.min(1,vizNormCdf((fwYds/2-d.off)/(d.latH/1.5))-vizNormCdf((-fwYds/2-d.off)/(d.latH/1.5))));
    chips.push({label:d.label,col,p:Math.round(pFw*100)});
    legs.push({label:`${d.label} · ${d.carry}y · ±${d.latH}y`,col});
  });
  // Range tick marks at user-defined interval
  const tickInt=interval||25;
  for(let y=tickInt;y<rangeTop;y+=tickInt){
    const ty=teeY-y*scale;
    annots+=`<line x1="${fwL-2}" y1="${ty}" x2="${fwR+2}" y2="${ty}" stroke="rgba(255,255,255,.12)" stroke-width="1"/><text x="${fwL-4}" y="${ty+3}" font-family="monospace" font-size="7" fill="rgba(255,255,255,.45)" text-anchor="end">${y}y</text>`;
  }
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=`<defs>${defs}</defs>
  <rect width="${W}" height="${H}" fill="#6a9a50"/>
  <rect x="${fwL}" y="0" width="${fwR-fwL}" height="${H}" fill="#9ec880"/>
  <line x1="${fwL}" y1="0" x2="${fwL}" y2="${H}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <line x1="${fwR}" y1="0" x2="${fwR}" y2="${H}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <text x="${cx}" y="18" font-family="monospace" font-size="10" fill="rgba(255,255,255,.8)" text-anchor="middle">${escHtml(title)}</text>
  ${subtitle?`<text x="${cx}" y="30" font-family="monospace" font-size="8" fill="rgba(255,255,255,.5)" text-anchor="middle">${escHtml(subtitle)}</text>`:''}
  ${shapes}${annots}
  <circle cx="${cx}" cy="${teeY}" r="7" fill="#fff" stroke="#3d6b35" stroke-width="2.5"/>
  <line x1="${cx-5}" y1="${teeY+7}" x2="${cx+5}" y2="${teeY+7}" stroke="#3d6b35" stroke-width="2"/>
  <text x="${cx}" y="${teeY+20}" font-family="monospace" font-size="9" fill="rgba(255,255,255,.8)" text-anchor="middle">TEE</text>
  <text x="${cx}" y="${H-8}" font-family="monospace" font-size="9" fill="rgba(50,90,30,.9)" text-anchor="middle">← fairway ${fwYds}y →</text>`;
  vizSetLegendChips(legs,chips);
}

// ── Same-distance overlay renderer ───────────────────────────────────────────
export function vizDrawDistance(dispList,targetYds,fwYds,mode,title){
  const svg=document.getElementById('vizSvg');
  // All ellipses drawn at the same carry distance — overlapping comparison
  const clubs=dispList.filter(d=>d&&d.min>0&&d.max>=targetYds&&d.min<=targetYds);
  if(!clubs.length){svg.innerHTML=`<text x="220" y="260" text-anchor="middle" font-family="monospace" font-size="11" fill="#8a9e82">No clubs reach ${targetYds}y</text>`;return;}
  const W=440,H=420,PAD_T=48,PAD_B=80,cx=W/2;
  const teeY=H-PAD_B, landY=PAD_T+60;
  const scale=(teeY-landY)/targetYds;
  const fwH=fwYds/2*scale,fwL=cx-fwH,fwR=cx+fwH;
  let defs='',shapes='',annots='';const legs=[],chips=[];
  clubs.forEach((d,i)=>{
    const aimX=cx+d.off*scale;
    const rxR=d.rxR*scale,rxL=d.rxL*scale,ryU=d.dl*scale,ryD=d.ds*scale,eCy=landY+ryD*.1;
    const col=VIZ_COLORS[i%VIZ_COLORS.length];
    // Render at lower opacity when multiple overlap
    const opacity=Math.max(0.55, 0.85-i*0.06);
    const ep=vizEllipsePath(aimX,eCy,rxR,rxL,ryU,ryD,d.tilt);
    const rv=parseInt(col.slice(1,3),16),gv=parseInt(col.slice(3,5),16),bv=parseInt(col.slice(5,7),16);
    defs+=`<clipPath id="vcp${i}"><path d="${ep}"/></clipPath>`;
    if(mode!=='prob') shapes+=`<path d="${ep}" fill="rgba(${rv},${gv},${bv},0.08)" stroke="${col}" stroke-width="2" opacity="${opacity}"/>`;
    if(mode!=='shape') shapes+=`<g clip-path="url(#vcp${i})" opacity="${opacity}">
      <path d="M ${aimX} ${eCy-ryU-14} L ${aimX+260} ${eCy-ryU+246} L ${aimX+260} ${eCy+ryD+274} L ${aimX} ${eCy+ryD+14} Z" fill="rgba(200,80,40,${(0.10+d.pR*.30).toFixed(2)})"/>
      <path d="M ${aimX} ${eCy-ryU-14} L ${aimX-260} ${eCy-ryU+246} L ${aimX-260} ${eCy+ryD+274} L ${aimX} ${eCy+ryD+14} Z" fill="rgba(50,110,200,${(0.10+d.pL*.30).toFixed(2)})"/>
    </g>`;
    // Label near top of each ellipse, staggered vertically
    annots+=`<text x="${aimX}" y="${eCy-ryU-14-i*10}" font-family="monospace" font-size="9" fill="${col}" font-weight="600" text-anchor="middle">${escHtml(d.label)}</text>`;
    const pFw=Math.max(0,Math.min(1,vizNormCdf((fwYds/2-d.off)/(d.latH/1.5))-vizNormCdf((-fwYds/2-d.off)/(d.latH/1.5))));
    chips.push({label:d.label,col,p:Math.round(pFw*100)});
    legs.push({label:`${d.label} · ±${d.latH}y`,col});
  });
  // Distance markers
  for(let y=Math.round(targetYds/4)*1;y<targetYds;y+=Math.round(targetYds/4)){
    const my=teeY-y*scale;
    annots+=`<text x="${fwL-4}" y="${my+3}" font-family="monospace" font-size="7" fill="rgba(255,255,255,.4)" text-anchor="end">${y}y</text>`;
  }
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=`<defs>${defs}</defs>
  <rect width="${W}" height="${H}" fill="#6a9a50"/>
  <rect x="${fwL}" y="0" width="${fwR-fwL}" height="${H}" fill="#9ec880"/>
  <line x1="${fwL}" y1="0" x2="${fwL}" y2="${H}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <line x1="${fwR}" y1="0" x2="${fwR}" y2="${H}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <text x="${cx}" y="18" font-family="monospace" font-size="10" fill="rgba(255,255,255,.8)" text-anchor="middle">${escHtml(title)} · ${targetYds}y target</text>
  <text x="${cx}" y="30" font-family="monospace" font-size="8" fill="rgba(255,255,255,.5)" text-anchor="middle">${clubs.length} club${clubs.length!==1?'s':''} reach this distance — overlapping ellipses</text>
  ${shapes}${annots}
  <circle cx="${cx}" cy="${teeY}" r="7" fill="#fff" stroke="#3d6b35" stroke-width="2.5"/>
  <line x1="${cx-5}" y1="${teeY+7}" x2="${cx+5}" y2="${teeY+7}" stroke="#3d6b35" stroke-width="2"/>
  <text x="${cx}" y="${teeY+20}" font-family="monospace" font-size="9" fill="rgba(255,255,255,.8)" text-anchor="middle">TEE</text>
  <text x="${cx}" y="${H-8}" font-family="monospace" font-size="9" fill="rgba(50,90,30,.9)" text-anchor="middle">← fairway ${fwYds}y →</text>`;
  vizSetLegendChips(legs,chips);
}

// ── Hole view renderer ────────────────────────────────────────────────────────
export function vizDrawHole(hcp,handed,fwYds,mode,pathClubs){
  const svg=document.getElementById('vizSvg'); if(!svg) return;
  if(!vizActiveCourse){svg.innerHTML='<text x="220" y="260" text-anchor="middle" font-family="monospace" font-size="11" fill="#8a9e82">No course selected</text>';return;}
  const tee=vizActiveTee||vizActiveCourse.tees?.[0]; if(!tee?.holes?.length) return;
  const hole=tee.holes.find(h=>h.number===vizSelectedHole)||tee.holes[0];
  if(!hole?.yards){svg.innerHTML='<text x="220" y="260" text-anchor="middle" font-family="monospace" font-size="11" fill="#8a9e82">No yardage for this hole</text>';return;}

  const W=440,PAD_T=50,PAD_B=72,H=600;
  const scale=(H-PAD_T-PAD_B)/hole.yards;
  const cx=W/2,teeY=H-PAD_B,fwH=fwYds/2*scale,fwL=cx-fwH,fwR=cx+fwH;
  let defs='',shapes='',annots='';const legs=[],chips=[];
  let uid=0;

  (pathClubs||[]).forEach((clubs,pi)=>{
    if(!vizPathVisible[pi]||!clubs?.length) return;
    const baseCol=VIZ_PATH_COLORS[pi%VIZ_PATH_COLORS.length];
    let cumCarry=0;
    clubs.forEach((club,si)=>{
      const d=vizGetDisp(club,hcp,handed,profile.yardType||'Total',vizYardMode); if(!d?.carry) return;
      cumCarry+=d.carry;
      const yft=Math.min(cumCarry,hole.yards-5);
      const col=si===0?baseCol:vizLightenHex(baseCol,Math.min(si*0.28,0.65));
      const carryY=teeY-yft*scale, aimX=cx+d.off*scale;
      const rxR=d.rxR*scale,rxL=d.rxL*scale,ryU=d.dl*scale,ryD=d.ds*scale,eCy=carryY+ryD*.1;
      const es=vizRenderEllipse(uid++,aimX,eCy,rxR,rxL,ryU,ryD,d.tilt,col,d.pR,d.pL,d.pS,d.pLn,mode);
      defs+=es.match(/<clipPath[^>]*>.*?<\/clipPath>/s)?.[0]||'';
      shapes+=es.replace(/<clipPath[^>]*>.*?<\/clipPath>/s,'');
      const lx=Math.min(W-2,aimX+rxR+5);
      annots+=`<text x="${lx}" y="${eCy-3}" font-family="monospace" font-size="9" fill="${col}" font-weight="600">${escHtml('P'+(pi+1)+'\xb7'+d.label)}</text>`;
      annots+=`<line x1="${fwL-16}" y1="${carryY}" x2="${fwL-3}" y2="${carryY}" stroke="${col}" stroke-width="1" opacity=".8"/><text x="${fwL-18}" y="${carryY+4}" font-family="monospace" font-size="8" fill="${col}" text-anchor="end">${Math.round(yft)}y</text>`;
      if(si===clubs.length-1){
        const pFw=Math.max(0,Math.min(1,vizNormCdf((fwYds/2-d.off)/(d.latH/1.5))-vizNormCdf((-fwYds/2-d.off)/(d.latH/1.5))));
        chips.push({label:'P'+(pi+1)+' \xb7 '+clubs.map(c=>c.identifier||c.type).join('\u2192'),col:baseCol,p:Math.round(pFw*100)});
      }
      legs.push({label:'P'+(pi+1)+' \xb7 '+d.label+' \xb7 '+Math.round(yft)+'y',col});
    });
  });

  for(let y=50;y<hole.yards;y+=50){const my=teeY-y*scale;
    annots+=`<line x1="${fwL-2}" y1="${my}" x2="${fwL+2}" y2="${my}" stroke="rgba(255,255,255,.3)" stroke-width="1"/><text x="${fwL-4}" y="${my+3}" font-family="monospace" font-size="7" fill="rgba(255,255,255,.35)" text-anchor="end">${y}y</text>`;}
  const gy=PAD_T+8;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=`<defs>${defs}</defs>
  <rect width="${W}" height="${H}" fill="#6a9a50"/>
  <rect x="${fwL}" y="${gy+14}" width="${fwR-fwL}" height="${teeY-gy-14}" fill="#9ec880"/>
  <line x1="${fwL}" y1="${gy+14}" x2="${fwL}" y2="${teeY}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <line x1="${fwR}" y1="${gy+14}" x2="${fwR}" y2="${teeY}" stroke="rgba(50,90,30,.4)" stroke-width="1"/>
  <ellipse cx="${cx}" cy="${gy+10}" rx="${fwH*1.5}" ry="10" fill="rgba(30,130,60,.8)" stroke="#28a050" stroke-width="1.5"/>
  <text x="${cx}" y="${gy+14}" font-family="monospace" font-size="8" fill="#fff" text-anchor="middle">GREEN</text>
  <text x="${cx}" y="18" font-family="monospace" font-size="10" fill="rgba(255,255,255,.85)" text-anchor="middle">${escHtml(vizActiveCourse.name)} \xb7 H${hole.number} \xb7 Par ${hole.par} \xb7 ${hole.yards}y</text>
  <text x="${cx}" y="30" font-family="monospace" font-size="8" fill="rgba(255,255,255,.5)" text-anchor="middle">HCP ${hole.handicap||'?'} \xb7 ${vizActiveTee?.name||''}</text>
  ${shapes}${annots}
  <circle cx="${cx}" cy="${teeY}" r="7" fill="#fff" stroke="#3d6b35" stroke-width="2.5"/>
  <line x1="${cx-5}" y1="${teeY+7}" x2="${cx+5}" y2="${teeY+7}" stroke="#3d6b35" stroke-width="2"/>
  <text x="${cx}" y="${teeY+20}" font-family="monospace" font-size="9" fill="rgba(255,255,255,.8)" text-anchor="middle">TEE</text>
  <text x="${cx}" y="${H-8}" font-family="monospace" font-size="9" fill="rgba(50,90,30,.9)" text-anchor="middle">\u2190 fairway ${fwYds}y \u2192</text>`;
  vizSetLegendChips(legs,chips);
}

export function vizSetLegendChips(legs,chips){
  const legEl=document.getElementById('vizLegend');
  const chipEl=document.getElementById('vizChips');
  if(!legEl||!chipEl) return;
  legEl.innerHTML=legs.map(l=>`<div style="display:flex;align-items:center;gap:5px;font-size:.62rem;color:var(--tx2)"><div style="width:14px;height:3px;border-radius:2px;background:${l.col}"></div>${escHtml(l.label)}</div>`).join('');
  chipEl.innerHTML=chips.map(c=>{
    const cls=c.p>=60?'background:var(--gr3);border-color:var(--gr2);color:var(--ac)':c.p>=35?'background:var(--sand2);border-color:var(--sand);color:var(--gold)':'background:#fdf0f0;border-color:#e0b0b0;color:var(--danger)';
    return`<span style="padding:3px 8px;border-radius:4px;font-size:.6rem;border:1px solid var(--br);${cls}">${escHtml(c.label)} ${c.p}% fw</span>`;}).join('');
}

// ── Main render dispatch ──────────────────────────────────────────────────────
export function renderViz(){
  if(vizMode==='dispersion') return;
  if(!document.getElementById('vizSvg')) return; // tab not yet active
  const hcp=getHandicap()||25, handed=profile.handed||'Right-handed';
  const fwYds=+document.getElementById('vizFwWidth')?.value||35;
  const mode=vizDisplayMode;

  if(vizMode==='coverage'){
    const noteEl=document.getElementById('vizHoleNote');
    if(noteEl) noteEl.style.display='none';
    let clubs=[];
    if(vizClubSrc==='custom'){
      clubs=bag.filter(c=>c.tested&&c.type!=='Putter'&&vizSelectedClubs.has(c.id));
    } else {
      const entry=history.find(h=>h.id===document.getElementById('vizOptSessionSelect')?.value);
      clubs=entry?vizClubsFromEntry(entry):bag.filter(c=>c.tested&&c.type!=='Putter');
    }
    const disps=clubs.map(c=>vizGetDisp(c,hcp,handed,profile.yardType||'Total',vizYardMode)).filter(Boolean);
    const title=vizClubSrc==='optimised'?'Optimised bag · HCP '+hcp:'Custom · HCP '+hcp;
    const maxRange=+document.getElementById('vizMaxRange')?.value||calcVizMaxRange();
    const interval=+document.getElementById('vizRangeInterval')?.value||25;
    vizDrawCanvas(disps,fwYds,mode,title,'',maxRange,interval);
  } else {
    // hole planning — update note strip
    const entry=history.find(h=>h.id===document.getElementById('vizHoleSessionSelect')?.value);
    const noteEl=document.getElementById('vizHoleNote');
    if(entry&&noteEl){
      const holeLine=(entry.text||'').split('\n').find(l=>new RegExp(`^H${vizSelectedHole}\\s*\\|`).test(l.trim()));
      if(holeLine){noteEl.textContent=holeLine.trim();noteEl.style.display='block';}
      else{noteEl.style.display='none';}
    } else if(noteEl){noteEl.style.display='none';}
    // Build pathClubs from vizPaths state
    const pathClubs=vizPaths.map(path=>path.map(id=>bag.find(c=>c.id===id)).filter(Boolean));
    vizDrawHole(hcp,handed,fwYds,mode,pathClubs);
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
export function onVizModeChange(m){
  vizMode=m;
  ['coverage','hole','dispersion'].forEach(x=>{
    const btn=document.getElementById('vmode-'+x);
    if(btn) btn.classList.toggle('on',x===m);
  });
  document.getElementById('vizCoverageControls').style.display   = m==='coverage'   ? 'block' : 'none';
  document.getElementById('vizHoleControls').style.display       = m==='hole'       ? 'block' : 'none';
  document.getElementById('vizDispersionControls').style.display = m==='dispersion' ? 'block' : 'none';
  document.getElementById('vizSharedControls').style.display     = m==='dispersion' ? 'none'  : 'flex';
  document.getElementById('vizSvgCard').style.display            = m==='dispersion' ? 'none'  : 'block';
  document.getElementById('vizDispOutput').style.display         = m==='dispersion' ? 'block' : 'none';
  if(m==='dispersion') initVizDisp();
  else renderViz();
}
function onVizClubSrcChange(){
  vizClubSrc=document.getElementById('vizClubSrcSel').value;
  document.getElementById('vizOptSessionField').style.display=vizClubSrc==='optimised'?'flex':'none';
  document.getElementById('vizClubShelf').style.display='flex';
  if(vizClubSrc==='optimised') syncOptimisedSelection();
  buildVizDistanceDropdown();
  const mrEl=document.getElementById('vizMaxRange');
  if(mrEl) mrEl.value=calcVizMaxRange();
  renderViz();
}
export function onVizOptSessionChange(){
  syncOptimisedSelection();
  buildVizDistanceDropdown();
  renderViz();
}
export function vizClubsFromEntry(entry){
  // Prefer structured bagMap; fall back to text parsing for legacy entries
  if(entry.bagMap?.length){
    return entry.bagMap.map(id=>bag.find(c=>c.tested&&c.sessions?.length&&(c.identifier===id||(c.type==='Driver'&&id==='Driver')))).filter(Boolean);
  }
  // Legacy: parse "1. Driver ...", "2. 5 Wood ...", etc.
  const usedIds=[];
  (entry.text||'').split('\n').forEach(l=>{const m=l.match(/^\d+\.\s+(\S+)/);if(m)usedIds.push(m[1]);});
  return bag.filter(c=>c.tested&&c.sessions?.length&&usedIds.some(u=>c.identifier?.startsWith(u)||(c.type==='Driver'&&u==='Driver')));
}
export function syncOptimisedSelection(){
  const entry=history.find(h=>h.id===document.getElementById('vizOptSessionSelect')?.value);
  if(!entry) return;
  vizSelectedClubs.clear();
  vizClubsFromEntry(entry).forEach(c=>vizSelectedClubs.add(c.id));
  // Update shelf visuals
  document.querySelectorAll('[id^=vclbl]').forEach(lbl=>{
    const id=lbl.id.replace('vclbl','');
    const on=vizSelectedClubs.has(id);
    lbl.style.background=on?'var(--gr3)':'var(--bg)';
    lbl.style.borderColor=on?'var(--gr2)':'var(--br)';
  });
}
export function onVizCourseChange(){
  const id=document.getElementById('vizCourseSelect').value;
  vizActiveCourse=courses.find(c=>c.id===id)||null;
  // Rebuild tee dropdown, default to course's selectedTee
  const tsel=document.getElementById('vizTeeSelect');
  if(vizActiveCourse?.tees?.length){
    tsel.innerHTML=vizActiveCourse.tees.map(t=>`<option value="${t.id}">${escHtml(t.name)} (${t.yardage}y)</option>`).join('');
    tsel.value=vizActiveCourse.selectedTee||vizActiveCourse.tees[0].id;
  } else {
    tsel.innerHTML='<option>—</option>';
  }
  vizActiveTee=vizActiveCourse?.tees?.find(t=>t.id===tsel.value)||vizActiveCourse?.tees?.[0]||null;
  buildVizHoleShelf(); vizSelectedHole=1;
  syncHoleClubsFromSession();
  renderViz();
}
export function onVizTeeChange(){
  const id=document.getElementById('vizTeeSelect').value;
  vizActiveTee=vizActiveCourse?.tees?.find(t=>t.id===id)||null;
  buildVizHoleShelf(); vizSelectedHole=1;
  // Try to find a session matching the newly selected tee; if found, update session picker
  if(vizActiveTee&&vizActiveCourse){
    const teeName=vizActiveTee.name.toLowerCase();
    const matchSess=history.find(h=>
      h.tee&&h.tee.toLowerCase()===teeName&&
      h.course&&vizActiveCourse.name&&h.course.toLowerCase().includes(vizActiveCourse.name.toLowerCase().split(' ')[0])
    );
    if(matchSess){
      const sel=document.getElementById('vizHoleSessionSelect');
      if(sel) sel.value=matchSess.id;
    }
  }
  syncHoleClubsFromSession();
  renderViz();
}
export function onVizHoleSessionChange(){
  vizHoleEdits={};
  const entry=history.find(h=>h.id===document.getElementById('vizHoleSessionSelect')?.value);
  if(!entry) return renderViz();
  // Snap course — strict: session course name must contain first word of stored course name
  if(entry.course){
    const ec=entry.course.toLowerCase();
    const matchCourse=courses.find(c=>{
      if(!c.name) return false;
      const cn=c.name.toLowerCase();
      return ec.includes(cn.split(' ')[0])||cn.includes(ec.split(' ')[0]);
    });
    if(matchCourse){
      vizActiveCourse=matchCourse;
      const csel=document.getElementById('vizCourseSelect');
      if(csel) csel.value=matchCourse.id;
      const tsel=document.getElementById('vizTeeSelect');
      if(tsel&&matchCourse.tees?.length){
        tsel.innerHTML=matchCourse.tees.map(t=>`<option value="${t.id}">${escHtml(t.name)} (${t.yardage}y)</option>`).join('');
        tsel.value=matchCourse.selectedTee||matchCourse.tees[0].id;
      }
      vizActiveTee=matchCourse.tees?.find(t=>t.id===document.getElementById('vizTeeSelect')?.value)||matchCourse.tees?.[0]||null;
    }
  }
  // Snap tee to session tee name
  if(entry.tee&&vizActiveCourse){
    const matchTee=vizActiveCourse.tees?.find(t=>t.name.toLowerCase()===entry.tee.toLowerCase());
    if(matchTee){vizActiveTee=matchTee;const tsel=document.getElementById('vizTeeSelect');if(tsel)tsel.value=matchTee.id;}
  }
  buildVizHoleShelf();
  vizSelectedHole=1;
  syncHoleClubsFromSession();
  renderViz();
}
export function _saveCurrentHoleEdits(){
  if(!vizSelectedHole) return;
  vizHoleEdits[vizSelectedHole]={paths:vizPaths.map(p=>[...p]),visible:[...vizPathVisible]};
}
export function syncHoleClubsFromSession(){
  // Reset to empty first — no stale bleed across holes
  vizPaths=[[],[],[]];
  vizPathVisible=[true,false,false];
  // User edits take priority over session data
  const edit=vizHoleEdits[vizSelectedHole];
  if(edit){
    vizPaths=edit.paths.map(p=>[...p]);
    vizPathVisible=[...edit.visible];
    _rebuildPathPlanner();
    return;
  }
  const entry=history.find(h=>h.id===document.getElementById('vizHoleSessionSelect')?.value);
  if(!entry){_rebuildPathPlanner();return;}
  const hm=entry.holeMap?.[vizSelectedHole];
  if(hm&&hm.paths?.length){
    const findId=id=>id?bag.find(c=>c.identifier===id||(c.type==='Driver'&&id==='Driver'))?.id||'':null;
    hm.paths.slice(0,3).forEach((path,pi)=>{
      vizPaths[pi]=path.map(findId).filter(id=>id);
      vizPathVisible[pi]=vizPaths[pi].length>0;
    });
    vizPathVisible[0]=true; // path 1 always visible if it has clubs
    _rebuildPathPlanner();
    return;
  }
  // Legacy text fallback
  const hole=vizActiveTee?.holes?.find(h=>h.number===vizSelectedHole);
  if(!hole){_rebuildPathPlanner();return;}
  const hl=(entry.text||'').split('\n').find(l=>new RegExp(`H${hole.number}\\s*\\|`).test(l));
  if(!hl){_rebuildPathPlanner();return;}
  const rawTee=(hl.match(/(?:Tee|Club):\s*([^|]+)/i)||[])[1]?.trim()||'';
  const rawApp=(hl.match(/Approach:\s*([^|]+)/i)||[])[1]?.trim()||'';
  const findClub=raw=>{
    if(!raw) return null;
    let c=bag.find(b=>b.identifier===raw.split(' ')[0]||b.identifier===raw);
    if(c) return c;
    if(/^driver/i.test(raw)) return bag.find(b=>b.type==='Driver');
    const numMatch=raw.match(/^(\d+)\s*(wood|iron|hybrid)/i);
    if(numMatch){const num=numMatch[1],typeKw=numMatch[2].toLowerCase();const typeMap={wood:'Fairway Wood',iron:'Iron',hybrid:'Hybrid'};c=bag.find(b=>b.type===(typeMap[typeKw]||'')&&b.identifier.startsWith(num));if(c)return c;}
    return bag.find(b=>b.identifier===raw.split(' or ')[0].trim())||null;
  };
  const tc=findClub(rawTee),ac=findClub(rawApp.split(' or ')[0].trim());
  vizPaths[0]=[tc?.id,ac?.id].filter(Boolean);
  _rebuildPathPlanner();
}
/*let vizShotCount=1; // kept for legacy compat — path planner uses vizPaths directly
let vizPlannerOpen=false;*/
function _buildBagMap(){
  return bag.filter(c=>vizSelectedClubs.has(c.id)&&c.type!=='Putter').map(c=>c.identifier||c.type);
}
export function _buildHoleMapFromEdits(){
  // Save current hole before building
  _saveCurrentHoleEdits();
  const idToIdent=id=>bag.find(c=>c.id===id)?.identifier||'';
  const hm={};
  Object.entries(vizHoleEdits).forEach(([n,edit])=>{
    const namedPaths=edit.paths
      .map(path=>path.map(idToIdent).filter(Boolean))
      .filter(p=>p.length);
    if(namedPaths.length) hm[+n]={paths:namedPaths};
  });
  return hm;
}
export function saveManualBag(){
  if(!vizActiveCourse){alert('Select a course first.');return;}
  const bm=_buildBagMap();
  if(!bm.length){alert('Select at least one club in Bag Coverage first.');return;}
  const entry={
    id:uid(), date:new Date().toISOString(),
    type:'manual',
    course:vizActiveCourse.name||'',
    tee:vizActiveTee?.name||'',
    hcp:String(getHandicap()||''),
    playHcp:'', conditions:'', holes:'all 18',
    text:`Manual Bag — ${vizActiveCourse.name} (${vizActiveTee?.name||''} tees)\nClubs: ${bm.join(', ')}`,
    bagMap:bm,
    holeMap:undefined
  };
  history.unshift(entry);
  save();
  renderSessions();
  alert(`Bag saved: ${vizActiveCourse.name} — ${bm.length} clubs.`);
}
export function saveManualPlan(){
  if(!vizActiveCourse){alert('Select a course first.');return;}
  const bm=_buildBagMap();
  if(!bm.length){alert('Select at least one club in Bag Coverage first.');return;}
  const hm=_buildHoleMapFromEdits();
  if(!Object.keys(hm).length){alert('Plan at least one hole path in the Path Planner first.');return;}
  const entry={
    id:uid(), date:new Date().toISOString(),
    type:'manual',
    course:vizActiveCourse.name||'',
    tee:vizActiveTee?.name||'',
    hcp:String(getHandicap()||''),
    playHcp:'', conditions:'', holes:'all 18',
    text:`Manual Plan — ${vizActiveCourse.name} (${vizActiveTee?.name||''} tees)\nClubs: ${bm.join(', ')}\n${Object.keys(hm).length} holes planned.`,
    bagMap:bm,
    holeMap:hm
  };
  history.unshift(entry);
  save();
  renderSessions();
  alert(`Plan saved: ${vizActiveCourse.name} — ${bm.length} clubs, ${Object.keys(hm).length} holes.`);
}

export function vizTogglePlanner(){
  vizPlannerOpen=!vizPlannerOpen;
  document.getElementById('vizPlannerBody').style.display=vizPlannerOpen?'block':'none';
  document.getElementById('vizPlannerHdr')?.classList.toggle('open',vizPlannerOpen);
  document.getElementById('vizPlannerChevron').textContent=vizPlannerOpen?'\u25b2':'\u25bc';
}
export function vizTogglePath(pi){
  vizPathVisible[pi]=!vizPathVisible[pi];
  _rebuildPathPlanner();
  renderViz();
}
export function vizUpdatePath(pi,si,id){
  vizPaths[pi][si]=id;
  renderViz();
}
export function vizAddShotToPath(pi){
  if(vizPaths[pi].length>=6) return;
  vizPaths[pi].push('');
  _rebuildPathPlanner();
  renderViz();
}
export function vizRemoveShotFromPath(pi){
  if(vizPaths[pi].length<=1) return;
  vizPaths[pi].pop();
  _rebuildPathPlanner();
  renderViz();
}
export function _rebuildPathPlanner(){
  const rowsEl=document.getElementById('vizPathRows');
  if(!rowsEl) return;
  const shelfIds=vizSelectedClubs.size?vizSelectedClubs:new Set(bag.filter(c=>c.tested&&c.type!=='Putter').map(c=>c.id));
  const allClubs=bag.filter(c=>c.tested&&c.type!=='Putter'&&(vizMode!=='hole'||shelfIds.has(c.id)));
  const none='<option value="">\u2014 none \u2014</option>';
  const clubOpts=none+allClubs.map(c=>`<option value="${c.id}">${escHtml(c.identifier||c.type)}</option>`).join('');
  const PATH_NAMES=['Path 1','Path 2','Path 3'];
  const PATH_COLORS=VIZ_PATH_COLORS;

  document.getElementById('vizPathRows').innerHTML=vizPaths.map((path,pi)=>{
    const col=PATH_COLORS[pi];
    const vis=vizPathVisible[pi];
    // Always show 6 shot slots per path
    const slots=Array.from({length:6},(_,si)=>{
      const id=path[si]||'';
      return `<select onchange="vizUpdatePath(${pi},${si},this.value)" style="min-width:95px;font-size:.64rem">${clubOpts}</select>`;
    }).join('');
    return `<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:6px 0;border-bottom:1px solid var(--br)">
      <button onclick="vizTogglePath(${pi})" style="width:12px;height:12px;border-radius:50%;border:2px solid ${col};background:${vis?col:'transparent'};cursor:pointer;flex-shrink:0;padding:0" title="${vis?'Hide':'Show'} path ${pi+1}"></button>
      <span style="font-size:.6rem;color:${col};font-weight:600;width:44px;flex-shrink:0">${PATH_NAMES[pi]}</span>
      <div id="vizPathSels${pi}" style="display:flex;flex-wrap:wrap;gap:4px">${slots}</div>
    </div>`;
  }).join('');

  // Set select values
  vizPaths.forEach((path,pi)=>{
    const sels=document.querySelectorAll(`#vizPathSels${pi} select`);
    sels.forEach((sel,si)=>{sel.value=path[si]||'';});
  });
}
export function vizAddShot(){ vizAddShotToPath(0); }
export function vizRemoveShot(){ vizRemoveShotFromPath(0); }
export function _rebuildShotSlots(){ _rebuildPathPlanner(); } // alias for compat
/*export function calcVizMaxRange(){
  const actives=bag.filter(c=>c.tested&&c.sessions?.length&&c.type!=='Putter');
  const maxes=actives.flatMap(c=>c.sessions.map(s=>+s.max)).filter(v=>v>0);
  if(!maxes.length) return 300;
  return Math.ceil(Math.max(...maxes)*1.2/10)*10;
}*/
export function resetVizMaxRange(){
  const el=document.getElementById('vizMaxRange');
  if(el) el.value=calcVizMaxRange();
}
export function setVizYard(m){
  vizYardMode=m;
  ['carry','total'].forEach(x=>document.getElementById('vytgl-'+x).classList.toggle('on',x===m));
  resetVizMaxRange();
  renderViz();
}
export function setVizDisplay(m){
  vizDisplayMode=m;
  ['both','shape','prob'].forEach(x=>document.getElementById('vptgl-'+x).classList.toggle('on',x===m));
  renderViz();
}
export function buildVizHoleShelf(){
  if(!vizActiveTee?.holes?.length) return;
  const shelf=document.getElementById('vizHoleShelf');
  if(!shelf) return;
  shelf.innerHTML=vizActiveTee.holes.map(h=>
    `<button onclick="vizSelectHole(${h.number})" style="padding:5px 7px;background:${h.number===vizSelectedHole?'var(--gr3)':'var(--sf)'};border:1px solid ${h.number===vizSelectedHole?'var(--gr2)':'var(--br)'};border-radius:4px;font-family:inherit;font-size:.6rem;color:${h.number===vizSelectedHole?'var(--ac2)':'var(--tx2)'};cursor:pointer;text-align:center;min-width:40px" id="vhbtn${h.number}">H${h.number}<br><span style="font-size:.52rem;color:var(--tx3)">P${h.par}\xb7${h.yards||'?'}y</span></button>`).join('');
}
export function vizSelectHole(n){
  _saveCurrentHoleEdits();
  vizSelectedHole=n;
  document.querySelectorAll('[id^=vhbtn]').forEach(b=>{
    const hn=+b.id.replace('vhbtn','');
    b.style.background=hn===n?'var(--gr3)':'var(--sf)';
    b.style.borderColor=hn===n?'var(--gr2)':'var(--br)';
    b.style.color=hn===n?'var(--ac2)':'var(--tx2)';
  });
  syncHoleClubsFromSession();
  renderViz();
}
export function buildVizDistanceDropdown(){
  let clubs=[];
  if(vizClubSrc==='custom') clubs=bag.filter(c=>c.tested&&c.sessions?.length&&vizSelectedClubs.has(c.id));
  else{
    const entry=history.find(h=>h.id===document.getElementById('vizOptSessionSelect')?.value);
    if(entry) clubs=vizClubsFromEntry(entry);
    else clubs=bag.filter(c=>c.tested&&c.sessions?.length&&c.type!=='Putter');
  }
  const allMax=clubs.flatMap(c=>c.sessions.map(s=>+s.max)).filter(v=>v>0);
  const allMin=clubs.flatMap(c=>c.sessions.map(s=>+s.min)).filter(v=>v>0);
  const sel=document.getElementById('vizDistTarget');
  if(!sel) return;
  if(!allMax.length){sel.innerHTML='<option value="">All distances</option>';return;}
  let opts='<option value="">All distances</option>';
  for(let y=Math.ceil(Math.min(...allMin)/10)*10;y<=Math.floor(Math.max(...allMax)/10)*10;y+=10){
    const ct=clubs.filter(c=>c.sessions.some(s=>+s.min<=y&&+s.max>=y)).length;
    if(ct>0) opts+=`<option value="${y}">${y}y (${ct} club${ct!==1?'s':''})</option>`;
  }
  sel.innerHTML=opts;
}
export function initViz(){
  if(vizInitDone){renderViz();return;}
  vizInitDone=true;
  const sess=history.filter(h=>h.type==='optimisation'||h.type==='caddie'||h.type==='both'||h.type==='manual');
  const sessOpts=sess.length
    ? sess.map(h=>`<option value="${h.id}">${fmtDate(h.date)} \xb7 ${escHtml(h.course)} (${escHtml(h.tee||'')})</option>`).join('')
    : '<option value="">No sessions yet</option>';
  document.getElementById('vizOptSessionSelect').innerHTML=sessOpts;
  document.getElementById('vizHoleSessionSelect').innerHTML='<option value="">\u2014 none \u2014</option>'+sessOpts;
  // Course dropdown — default to home course or first course
  const csel=document.getElementById('vizCourseSelect');
  csel.innerHTML=courses.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  vizActiveCourse=courses.find(c=>c.id===profile.homeCourseId)||courses[0]||null;
  if(vizActiveCourse) csel.value=vizActiveCourse.id;
  // Tee dropdown — default to course's selectedTee
  const tsel=document.getElementById('vizTeeSelect');
  if(vizActiveCourse?.tees?.length){
    tsel.innerHTML=vizActiveCourse.tees.map(t=>`<option value="${t.id}">${escHtml(t.name)} (${t.yardage}y)</option>`).join('');
    tsel.value=vizActiveCourse.selectedTee||vizActiveCourse.tees[0].id;
  }
  vizActiveTee=vizActiveCourse?.tees?.find(t=>t.id===tsel.value)||vizActiveCourse?.tees?.[0]||null;
  // Init path planner with one empty path
  vizPaths=[[],[],[]]; vizPathVisible=[true,false,false]; vizHoleEdits={};
  _rebuildPathPlanner();
  // Reset club selection — ensures IDs match current bag after any import
  vizSelectedClubs=new Set();
  const shelfClubs=bag.filter(c=>c.tested&&c.type!=='Putter');
  shelfClubs.slice(0,4).forEach(c=>vizSelectedClubs.add(c.id));
  document.getElementById('vizClubShelf').innerHTML=shelfClubs.map((c,i)=>
    `<label onclick="vizToggleClub('${c.id}')" style="display:flex;align-items:center;gap:5px;padding:4px 9px;background:${vizSelectedClubs.has(c.id)?'var(--gr3)':'var(--bg)'};border:1px solid ${vizSelectedClubs.has(c.id)?'var(--gr2)':'var(--br)'};border-radius:4px;cursor:pointer;font-size:.66rem;transition:all .15s" id="vclbl${c.id}">
      <div style="width:8px;height:8px;border-radius:2px;background:${VIZ_COLORS[i%VIZ_COLORS.length]};flex-shrink:0"></div>
      ${escHtml(c.identifier||c.id)} <span style="color:var(--tx3);font-size:.58rem">${(()=>{const st=deriveStats(c.sessions);return st?Math.round((st.avgMin+st.avgMax)/2):'?'})()}y</span>
    </label>`).join('');
  buildVizHoleShelf();
  buildVizDistanceDropdown();
  syncOptimisedSelection();
  syncHoleClubsFromSession();
  onVizModeChange('coverage');
}
export function vizToggleClub(id){
  if(vizSelectedClubs.has(id)) vizSelectedClubs.delete(id);
  else{if(vizSelectedClubs.size>=13){alert('Maximum 13 clubs (14 with putter). Deselect a club first.');return;}vizSelectedClubs.add(id);}
  const on=vizSelectedClubs.has(id);
  const lbl=document.getElementById('vclbl'+id);
  if(lbl){lbl.style.background=on?'var(--gr3)':'var(--bg)';lbl.style.borderColor=on?'var(--gr2)':'var(--br)';}
  buildVizDistanceDropdown();
  renderViz();
}

function _dispArcPath(cx,cy,r1,r2,startDeg,endDeg){
  var rad=function(d){ return d*Math.PI/180; };
  var pt=function(r,a){ return [(cx+r*Math.sin(rad(a))).toFixed(3),(cy-r*Math.cos(rad(a))).toFixed(3)]; };
  var s1=pt(r2,startDeg), e1=pt(r2,endDeg);
  var s2=pt(r1,endDeg),   e2=pt(r1,startDeg);
  return 'M '+s1[0]+' '+s1[1]+' A '+r2+' '+r2+' 0 0 1 '+e1[0]+' '+e1[1]+
         ' L '+s2[0]+' '+s2[1]+' A '+r1+' '+r1+' 0 0 0 '+e2[0]+' '+e2[1]+' Z';
}

function _buildDispRadialSVG(heatCounts, heatMax){
  var cx=150, cy=150;
  var rB=ZONE_RING_RADII.bull, rI=ZONE_RING_RADII.inner, rO=ZONE_RING_RADII.outer;
  var bg='<rect width="300" height="300" fill="#6a9a50"/><rect x="90" y="0" width="120" height="300" fill="#9ec880"/>';
  var heatR=function(n){
    if(!heatMax||!n) return 'rgba(255,255,255,0.12)';
    return 'rgba(160,30,30,'+(0.18+(n/heatMax)*0.72).toFixed(2)+')';
  };
  var paths='';
  var i;
  for(i=0;i<8;i++){
    paths+='<path d="'+_dispArcPath(cx,cy,rB,rI,(i*45)-22.5,(i*45)+22.5)+'" fill="'+heatR(heatCounts['inner-'+i]||0)+'" stroke="rgba(255,255,255,0.40)" stroke-width="1.5"/>';
  }
  for(i=0;i<8;i++){
    paths+='<path d="'+_dispArcPath(cx,cy,rI,rO,(i*45)-22.5,(i*45)+22.5)+'" fill="'+heatR(heatCounts['outer-'+i]||0)+'" stroke="rgba(255,255,255,0.40)" stroke-width="1.5"/>';
  }
  paths+='<circle cx="150" cy="150" r="'+rB+'" fill="'+heatR(heatCounts['bull']||0)+'" stroke="rgba(255,255,255,0.40)" stroke-width="1.5"/>';
  var labels='';
  var total=Object.values(heatCounts).reduce(function(s,v){ return s+v; },0);
  if(total>0){
    var lbl=function(pct,x,y){ return pct>0?'<text x="'+x+'" y="'+y+'" font-family="monospace" font-size="9" fill="white" text-anchor="middle">'+pct+'%</text>':''; };
    var iMid=(rB+rI)/2, oMid=(rI+rO)/2;
    labels+=lbl(Math.round((heatCounts['bull']||0)/total*100),150,154);
    for(i=0;i<8;i++){
      var ang=i*45*Math.PI/180;
      labels+=lbl(Math.round((heatCounts['inner-'+i]||0)/total*100),(cx+iMid*Math.sin(ang)).toFixed(1),(cy-iMid*Math.cos(ang)+3).toFixed(1));
      labels+=lbl(Math.round((heatCounts['outer-'+i]||0)/total*100),(cx+oMid*Math.sin(ang)).toFixed(1),(cy-oMid*Math.cos(ang)+3).toFixed(1));
    }
  }
  return '<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:280px;display:block;margin:0 auto">'+bg+paths+labels+'</svg>';
}

export function initVizDisp(){
  if(vizDispInitDone){ renderVizDisp(); return; }
  vizDispInitDone=true;
  vizDispSelectedSessions=new Set((rangeSessions||[]).filter(function(s){ return s.committed; }).map(function(s){ return s.sessionId; }));
  _buildDispSessionShelf();
  _buildDispClubShelf();
  renderVizDisp();
}

function _buildDispSessionShelf(){
  var shelf=document.getElementById('vizDispSessionShelf');
  if(!shelf) return;
  var sessions=(rangeSessions||[]).filter(function(s){ return s.committed; });
  if(!sessions.length){
    shelf.innerHTML='<span style="font-size:.62rem;color:var(--tx3)">No committed range sessions yet.</span>';
    return;
  }
  shelf.innerHTML=sessions.map(function(s,i){
    var on=vizDispSelectedSessions.has(s.sessionId);
    var clubCount=(s.clubSummary||[]).length;
    var col=VIZ_COLORS[i%VIZ_COLORS.length];
    return '<label onclick="vizDispToggleSession(\''+s.sessionId+'\')" id="vdsess-'+s.sessionId+'"'+
      ' style="display:flex;align-items:center;gap:5px;padding:4px 9px;'+
      'background:'+(on?'var(--gr3)':'var(--bg)')+';border:1px solid '+(on?'var(--gr2)':'var(--br)')+';'+
      'border-radius:4px;cursor:pointer;font-size:.62rem;transition:all .15s">'+
      '<div style="width:8px;height:8px;border-radius:2px;background:'+col+';flex-shrink:0"></div>'+
      escHtml(fmtDate(s.date))+
      ' <span style="color:var(--tx3);font-size:.56rem">'+clubCount+' club'+(clubCount!==1?'s':'')+'</span>'+
      '</label>';
  }).join('');
}

function _buildDispClubShelf(){
  var shelf=document.getElementById('vizDispClubShelf');
  if(!shelf) return;
  // Key by clubId only — aggregate across all yardages
  var clubMap={};
  (rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); }).forEach(function(s){
    (s.clubSummary||[]).forEach(function(cs){
      if(!clubMap[cs.clubId]){
        clubMap[cs.clubId]={ clubId:cs.clubId, clubName:cs.clubName||cs.clubId, totalShots:0 };
      }
      (cs.targets||[]).forEach(function(t){ clubMap[cs.clubId].totalShots+=t.shotCount||0; });
    });
  });
  var clubIds=Object.keys(clubMap);
  if(!clubIds.length){
    shelf.innerHTML='<span style="font-size:.62rem;color:var(--tx3)">No sessions selected.</span>';
    vizDispSelectedKeys=new Set();
    return;
  }
  vizDispSelectedKeys=new Set(clubIds);
  shelf.innerHTML=clubIds.map(function(clubId,i){
    var cm=clubMap[clubId];
    var col=VIZ_COLORS[i%VIZ_COLORS.length];
    return '<label onclick="vizDispToggleClub(\''+clubId+'\')" id="vdclub-'+clubId+'"'+
      ' style="display:flex;align-items:center;gap:5px;padding:4px 9px;'+
      'background:var(--gr3);border:1px solid var(--gr2);'+
      'border-radius:4px;cursor:pointer;font-size:.62rem;transition:all .15s">'+
      '<div style="width:8px;height:8px;border-radius:2px;background:'+col+';flex-shrink:0"></div>'+
      escHtml(cm.clubName)+
      ' <span style="color:var(--tx3);font-size:.56rem">'+cm.totalShots+' shot'+(cm.totalShots!==1?'s':'')+'</span>'+
      '</label>';
  }).join('');
}

// Aggregate dispersion counts for a clubId, optionally filtered to one yardage
function _aggregateDispCounts(clubId, selectedSessions, yardageFilter){
  var counts={ bull:0 };
  var i;
  for(i=0;i<8;i++){ counts['inner-'+i]=0; counts['outer-'+i]=0; }
  var fp={ straight:0, 'left-to-right':0, 'right-to-left':0 };
  var totalShots=0;
  selectedSessions.forEach(function(s){
    var cs=(s.clubSummary||[]).find(function(x){ return x.clubId===clubId; });
    if(!cs) return;
    (cs.targets||[]).forEach(function(t){
      if(yardageFilter!==null && yardageFilter!==undefined && t.yardage!==yardageFilter) return;
      var d=t.dispersion;
      totalShots+=t.shotCount||0;
      counts.bull+=d.bull.total||0;
      Object.keys(d.bull.flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.bull.flightPaths[fp2]||0; });
      for(i=0;i<8;i++){
        if(d.inner[i]){ counts['inner-'+i]+=d.inner[i].total||0; Object.keys(d.inner[i].flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.inner[i].flightPaths[fp2]||0; }); }
        if(d.outer[i]){ counts['outer-'+i]+=d.outer[i].total||0; Object.keys(d.outer[i].flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.outer[i].flightPaths[fp2]||0; }); }
      }
    });
  });
  return { counts:counts, fp:fp, totalShots:totalShots };
}

// Build the inner content of a card (radial + stats + yardage chips) — used for initial render and surgical update
function _buildDispCardInner(clubId, clubName, selectedSessions, yardageFilter){
  var agg=_aggregateDispCounts(clubId, selectedSessions, yardageFilter);
  var counts=agg.counts, fp=agg.fp, totalShots=agg.totalShots;
  var heatMax=Math.max.apply(null,Object.values(counts).concat([1]));
  var innerTotal=0, outerTotal=0, i;
  for(i=0;i<8;i++){ innerTotal+=counts['inner-'+i]; outerTotal+=counts['outer-'+i]; }
  var pct=function(n,d){ return d>0?Math.round(n/d*100):0; };
  var statStr=totalShots>0
    ? 'Bull '+pct(counts.bull,totalShots)+'% \u00B7 '+
      'Str '+pct(fp.straight,totalShots)+'% \u00B7 '+
      'LtR '+pct(fp['left-to-right'],totalShots)+'% \u00B7 '+
      'RtL '+pct(fp['right-to-left'],totalShots)+'% \u00B7 '+
      'Inner '+pct(innerTotal,totalShots)+'% \u00B7 '+
      'Outer '+pct(outerTotal,totalShots)+'%'
    : 'No shot data';
  // Collect unique yardages for this club across selected sessions
  var yardageSet={};
  selectedSessions.forEach(function(s){
    var cs=(s.clubSummary||[]).find(function(x){ return x.clubId===clubId; });
    if(!cs) return;
    (cs.targets||[]).forEach(function(t){ yardageSet[t.yardage]=true; });
  });
  var yardages=Object.keys(yardageSet).map(Number).sort(function(a,b){ return a-b; });
  var yardageChips='';
  if(yardages.length>1){
    var chips=[{val:null,label:'All'}].concat(yardages.map(function(y){ return {val:y,label:y+'y'}; }));
    yardageChips='<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px">'+
      chips.map(function(ch){
        var on=(yardageFilter===null||yardageFilter===undefined)?ch.val===null:ch.val===yardageFilter;
        return '<button onclick="vizDispSetYardage(\''+clubId+'\','+(ch.val===null?'null':ch.val)+')"'+
          ' style="padding:2px 8px;font-size:.58rem;border-radius:4px;cursor:pointer;'+
          'background:'+(on?'var(--gr3)':'var(--bg)')+';border:1px solid '+(on?'var(--gr2)':'var(--br)')+'">'+
          ch.label+'</button>';
      }).join('')+
    '</div>';
  }
  return _buildDispRadialSVG(counts,heatMax)+
    '<div style="font-size:.58rem;color:var(--tx3);margin-top:8px;text-align:center;line-height:1.9">'+statStr+'</div>'+
    yardageChips;
}

export function renderVizDisp(){
  var out=document.getElementById('vizDispOutput');
  if(!out) return;
  var selectedSessions=(rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); });
  if(!selectedSessions.length){
    out.innerHTML='<div class="card"><div class="hist-empty">No sessions selected.</div></div>';
    return;
  }
  if(!vizDispSelectedKeys.size){
    out.innerHTML='<div class="card"><div class="hist-empty">No clubs selected.</div></div>';
    return;
  }
  var cards=[];
  vizDispSelectedKeys.forEach(function(clubId){
    // Resolve club name from session data first, fall back to bag
    var clubName=clubId;
    selectedSessions.some(function(s){
      var cs=(s.clubSummary||[]).find(function(x){ return x.clubId===clubId; });
      if(cs&&cs.clubName){ clubName=cs.clubName; return true; }
      return false;
    });
    var yardageFilter=vizDispYardageFilter[clubId]!==undefined?vizDispYardageFilter[clubId]:null;
    // Total shots badge — always all yardages
    var totalAll=_aggregateDispCounts(clubId,selectedSessions,null).totalShots;
    cards.push(
      '<div class="card" style="margin-bottom:10px" id="vdcard-'+clubId+'">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'+
          '<div style="font-family:\'Playfair Display\',serif;font-size:.95rem;color:var(--ac2)">'+escHtml(clubName)+'</div>'+
          '<span style="font-size:.58rem;padding:2px 7px;background:var(--gr3);border:1px solid var(--gr2);border-radius:4px;color:var(--ac)">'+totalAll+' shot'+(totalAll!==1?'s':'')+'</span>'+
        '</div>'+
        '<div id="vdcardinner-'+clubId+'">'+_buildDispCardInner(clubId,clubName,selectedSessions,yardageFilter)+'</div>'+
      '</div>'
    );
  });
  out.innerHTML=cards.length?cards.join(''):'<div class="card"><div class="hist-empty">No matching data for selection.</div></div>';
}

export function vizDispSetYardage(clubId, yardageFilter){
  vizDispYardageFilter[clubId]=yardageFilter===null||yardageFilter==='null'?null:+yardageFilter;
  var selectedSessions=(rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); });
  var clubName=clubId;
  selectedSessions.some(function(s){
    var cs=(s.clubSummary||[]).find(function(x){ return x.clubId===clubId; });
    if(cs&&cs.clubName){ clubName=cs.clubName; return true; }
    return false;
  });
  var inner=document.getElementById('vdcardinner-'+clubId);
  if(inner) inner.innerHTML=_buildDispCardInner(clubId,clubName,selectedSessions,vizDispYardageFilter[clubId]);
}

export function vizDispToggleSession(sessionId){
  if(vizDispSelectedSessions.has(sessionId)) vizDispSelectedSessions.delete(sessionId);
  else vizDispSelectedSessions.add(sessionId);
  var on=vizDispSelectedSessions.has(sessionId);
  var lbl=document.getElementById('vdsess-'+sessionId);
  if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  _buildDispClubShelf();
  renderVizDisp();
}

export function vizDispToggleClub(clubId){
  if(vizDispSelectedKeys.has(clubId)) vizDispSelectedKeys.delete(clubId);
  else vizDispSelectedKeys.add(clubId);
  var on=vizDispSelectedKeys.has(clubId);
  var lbl=document.getElementById('vdclub-'+clubId);
  if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  renderVizDisp();
}

Object.assign(window, {
  onVizModeChange, onVizClubSrcChange, onVizOptSessionChange,
  onVizCourseChange, onVizTeeChange, onVizHoleSessionChange,
  resetVizMaxRange, saveManualBag, saveManualPlan,
  setVizDisplay, setVizYard, vizSelectHole,
  vizToggleClub, vizTogglePath, vizTogglePlanner, vizUpdatePath,
  vizDispToggleSession, vizDispToggleClub, vizDispSetYardage
});
