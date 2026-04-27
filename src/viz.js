import { calcVizMaxRange } from './clubs.js';
import { vizFlightKey, vizTierIdx, vizNormCdf, vizLightenHex, vizEllipsePath, localISO, aggregateObservedDispersion } from './geo.js'; /* CLEAN11 */ /* ASKB-1 */
import { VIZ_COLORS, VIZ_PATH_COLORS, VIZ_LP, VIZ_ASYM, VIZ_LPROB, VIZ_ROLL, FLIGHT_DATA, BIAS_DATA, ZONE_RING_RADII } from './constants.js';
import { vizGetDisp } from './dispersion.js';
/* VIZMAP-2 -- map-backed hole planner */
import { geomLoadByCourse, geomLoadByCenter, geomOpenLocateModal,
         geomDistanceYds, geomBearingDeg } from './geomap.js';
import { MapView } from './mapview.js';

/* CLEAN11 -- _localISO centralised to geo.js as localISO(); local copy commented out
function _localISO() { var n=new Date(),p=function(x){return x<10?'0'+x:''+x;}; return n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+'T'+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds()); }
*/
import { bag, courses, history, rounds, profile, save, rangeSessions } from './store.js';

export let vizMode='coverage', vizDisplayMode='both', vizSelectedClubs=new Set();
export let vizSelectedHole=1, vizActiveCourse=null, vizActiveTee=null, vizInitDone=false, vizClubSrc='custom';
export let vizYardMode='total';
export let vizPaths=[[],[],[]]; // 3 paths, each = array of club IDs
export let vizPathVisible=[true,false,false];
export let vizHoleEdits={}; // scratchpad: hole number → {paths, visible} of club IDs
export let vizShotCount=1; // kept for legacy compat — path planner uses vizPaths directly
export let vizPlannerOpen=false;

/* VIZMAP-2 -- display mode toggle: synthetic | map. Defaults to synthetic. */
export let vizHoleViewMode = (function(){
  try { var v = localStorage.getItem('vc:viz:holeView'); return v === 'map' ? 'map' : 'synthetic'; }
  catch(e) { return 'synthetic'; }
})();

/* VIZMAP-2 -- map mode sub-state (module-local, NOT persisted). */
var vizMapState = {
  geo: null,                     /* {holes, polygons, center, bounds, boundary?} | null */
  fetchStatus: 'idle',           /* 'idle' | 'loading' | 'loaded' | 'failed' */
  fetchError: null,
  mapInstance: null,             /* MapView */
  styleMode: (function(){ try { return localStorage.getItem('vc:viz:mapStyle')==='plain'?'plain':'satellite'; } catch(e) { return 'satellite'; } })(),
  activePath: 0,                 /* 0|1|2, drives append-target on click */
  askbMode: (function(){ try { var v=localStorage.getItem('vc:viz:askbMode'); return v==='radial'||v==='ellipse'||v==='none'?v:'ellipse'; } catch(e) { return 'ellipse'; } })(),
  waypointMarkers: [[], [], []], /* maplibregl.Marker[] per path, parallel to vizHoleEdits[h].waypoints */
  askbSvg: null,                 /* SVG overlay element ref */
  pendingClubs: [null, null, null],  /* per-path: clubId selected but waypoint not yet placed */
  teeOverride: null,             /* [lng,lat] | null — per-mount tee override */
  _lastWaypointCounts: [0, 0, 0],
  _askbMoveBound: false
};

export let vizDispSelectedSessions = new Set();
export let vizDispSelectedKeys     = new Set();
export let vizDispInitDone         = false;
export let vizDispYardageFilter    = {}; // clubId -> yardage number | null (null = All)
export let vizDispSelectedRounds   = new Set(); // Set of history[] indices

/* ASKB-4 -- three independent visibility toggles (calc, rounds, range).
   calc=expected ellipse; rounds/range=observed heatmap sources (OR'd).
   Persisted to vc:askb:show. */
export let askbShow = (function(){
  try {
    var raw = localStorage.getItem('vc:askb:show');
    if (raw) {
      var p = JSON.parse(raw);
      if (p && typeof p === 'object') return { calc: p.calc !== false, rounds: p.rounds !== false, range: p.range !== false };
    }
  } catch(e) {}
  return { calc: true, rounds: true, range: true };
})();

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
    /* ASKB-4 -- expected ellipse gated by askbShow.calc */
    if(askbShow.calc){
      const es=vizRenderEllipse(i,aimX,eCy,rxR,rxL,ryU,ryD,d.tilt,col,d.pR,d.pL,d.pS,d.pLn,mode);
      defs+=es.match(/<clipPath[^>]*>.*?<\/clipPath>/s)?.[0]||'';
      shapes+=es.replace(/<clipPath[^>]*>.*?<\/clipPath>/s,'');
    }
    if(i>0){const prev=filtered[i-1],gap=prev.carry-prev.ds-(d.carry+d.dl);
      if(gap>12){const gy=teeY-((prev.carry-prev.ds+d.carry+d.dl)/2)*scale;
        annots+=`<line x1="${cx-20}" y1="${gy}" x2="${cx+20}" y2="${gy}" stroke="rgba(160,48,48,.4)" stroke-width="1" stroke-dasharray="3 2"/><text x="${cx}" y="${gy+4}" font-family="monospace" font-size="8" fill="rgba(160,48,48,.7)" text-anchor="middle">gap ~${Math.round(gap)}y</text>`;}}
    const lx=Math.min(W-2,aimX+rxR+5);
    annots+=`<text x="${lx}" y="${eCy-3}" font-family="monospace" font-size="9" fill="${col}" font-weight="600">${escHtml(d.label)}</text><text x="${lx}" y="${eCy+9}" font-family="monospace" font-size="8" fill="rgba(44,58,40,.6)">${d.carry}y</text>`;
    annots+=`<line x1="${fwL-16}" y1="${carryY}" x2="${fwL-3}" y2="${carryY}" stroke="${col}" stroke-width="1" opacity=".8"/><text x="${fwL-18}" y="${carryY+4}" font-family="monospace" font-size="8" fill="${col}" text-anchor="end">${d.carry}y</text>`;
    const pFw=Math.max(0,Math.min(1,vizNormCdf((fwYds/2-d.off)/(d.latH/1.5))-vizNormCdf((-fwYds/2-d.off)/(d.latH/1.5))));
    chips.push({label:d.label,col,p:Math.round(pFw*100)});
    legs.push({label:`${d.label} · ${d.carry}y · ±${d.latH}y`,col});
    /* ASKB-3 -- observed overlay centred on straight-shot target (cx, carryY), NOT biased ellipse centre.
       refR = simple average of lateral + depth extents (no tilt/asymmetry). Drift vs expected is the feature. */
    if(d._club){
      const obs=askbGetObserved(d._club);
      if(obs){
        const refR=((d.latH + (d.dl + d.ds)/2) / 2) * scale * 0.85; /* ASKB-FIX -- -15% radial size */
        annots+=vizRenderObservedMarker(cx,carryY,refR,obs,col);
      }
    }
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
      /* ASKB-4 -- expected ellipse gated by askbShow.calc */
      if(askbShow.calc){
        const es=vizRenderEllipse(uid++,aimX,eCy,rxR,rxL,ryU,ryD,d.tilt,col,d.pR,d.pL,d.pS,d.pLn,mode);
        defs+=es.match(/<clipPath[^>]*>.*?<\/clipPath>/s)?.[0]||'';
        shapes+=es.replace(/<clipPath[^>]*>.*?<\/clipPath>/s,'');
      }
      const lx=Math.min(W-2,aimX+rxR+5);
      annots+=`<text x="${lx}" y="${eCy-3}" font-family="monospace" font-size="9" fill="${col}" font-weight="600">${escHtml('P'+(pi+1)+'\xb7'+d.label)}</text>`;
      annots+=`<line x1="${fwL-16}" y1="${carryY}" x2="${fwL-3}" y2="${carryY}" stroke="${col}" stroke-width="1" opacity=".8"/><text x="${fwL-18}" y="${carryY+4}" font-family="monospace" font-size="8" fill="${col}" text-anchor="end">${Math.round(yft)}y</text>`;
      if(si===clubs.length-1){
        const pFw=Math.max(0,Math.min(1,vizNormCdf((fwYds/2-d.off)/(d.latH/1.5))-vizNormCdf((-fwYds/2-d.off)/(d.latH/1.5))));
        chips.push({label:'P'+(pi+1)+' \xb7 '+clubs.map(c=>c.identifier||c.type).join('\u2192'),col:baseCol,p:Math.round(pFw*100)});
        /* ASKB-3 -- observed overlay centred on straight-shot target (cx, carryY), simple radius. */
        const obs=askbGetObserved(club);
        if(obs){
          const refR=((d.latH + (d.dl + d.ds)/2) / 2) * scale * 0.85; /* ASKB-FIX -- -15% radial size */
          annots+=vizRenderObservedMarker(cx,carryY,refR,obs,col);
        }
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

// ── VIZMAP-2: frame helpers ───────────────────────────────────────────────────

function _vizHoleAxis(hole) {
  /* Returns { tee:[lng,lat], green:[lng,lat], bearing:number(0-360) } or null.
     Uses teeOverride if set (per-hole tee drag). */
  if (!hole) return null;
  var teePt = vizMapState.teeOverride || hole.tee;
  if (!teePt || !hole.green) return null;
  var brg = ((window.turf.bearing(window.turf.point(teePt), window.turf.point(hole.green)) % 360) + 360) % 360;
  return { tee: teePt, green: hole.green, bearing: brg };
}

function _vizFrameToLngLat(axis, alongYds, offsetYds) {
  /* Forward: project (along, off) from tee along axis bearing, then perp-offset. */
  var fwdPt  = window.turf.destination(window.turf.point(axis.tee), alongYds, axis.bearing, { units:'yards' });
  var perpBrg = (axis.bearing + 90 + 360) % 360;
  var finalPt = window.turf.destination(fwdPt, offsetYds, perpBrg, { units:'yards' });
  return finalPt.geometry.coordinates;
}

function _vizLngLatToFrame(axis, lngLat) {
  /* Inverse: distance + bearing from tee, decompose into (along, off). */
  var dYds = window.turf.distance(window.turf.point(axis.tee), window.turf.point(lngLat), { units:'yards' });
  var brg  = window.turf.bearing(window.turf.point(axis.tee), window.turf.point(lngLat));
  var rel  = ((brg - axis.bearing + 540) % 360) - 180;  /* -180..180 */
  var rad  = rel * Math.PI / 180;
  return {
    alongYds:  +(dYds * Math.cos(rad)).toFixed(2),
    offsetYds: +(dYds * Math.sin(rad)).toFixed(2)
  };
}

// ── VIZMAP-2: helpers ─────────────────────────────────────────────────────────

function _vizCurHoleGeo() {
  if (!vizMapState.geo || !vizMapState.geo.holes) return null;
  var want = String(vizSelectedHole);
  for (var key in vizMapState.geo.holes) {
    if (String(vizMapState.geo.holes[key].ref) === want) return vizMapState.geo.holes[key];
  }
  return null;
}

function _vizEnsureHoleEdit() {
  if (!vizHoleEdits[vizSelectedHole]) {
    vizHoleEdits[vizSelectedHole] = { paths: [[],[],[]], visible: vizPathVisible.slice(), waypoints: [[],[],[]] };
  }
  if (!vizHoleEdits[vizSelectedHole].waypoints) {
    vizHoleEdits[vizSelectedHole].waypoints = [[],[],[]];
  }
}

function _vizMapToast(msg) {
  var existing = document.getElementById('vizMapToast');
  if (existing) { try { existing.parentNode.removeChild(existing); } catch(e) {} }
  var el = document.createElement('div');
  el.id = 'vizMapToast';
  el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
    + 'background:rgba(0,0,0,.8);color:#fff;font-family:\'DM Mono\',monospace;font-size:.7rem;'
    + 'padding:7px 16px;border-radius:20px;z-index:9999;pointer-events:none;transition:opacity .4s';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function(){
    el.style.opacity = '0';
    setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 450);
  }, 1800);
}

// ── VIZMAP-2: sync ────────────────────────────────────────────────────────────

function _vizSyncWaypointsToMap() {
  if (!vizMapState.mapInstance) return;
  var hole = _vizCurHoleGeo();
  var axis = _vizHoleAxis(hole);
  if (!axis) {
    for (var p = 0; p < 3; p++) vizMapState.mapInstance.setWaypoints(p, []);
    return;
  }
  var edit = vizHoleEdits[vizSelectedHole];
  var fw = (edit && edit.waypoints) || [[],[],[]];
  for (var p = 0; p < 3; p++) {
    var arr = fw[p] || [];
    var lonlatArr = arr.map(function(f){ return _vizFrameToLngLat(axis, f.alongYds, f.offsetYds); });
    vizMapState.mapInstance.setWaypoints(p, lonlatArr);
  }
  /* Recalibrate _lastWaypointCounts to avoid stale-add detection */
  vizMapState._lastWaypointCounts = [fw[0].length, fw[1].length, fw[2].length];
}

// ── VIZMAP-2: waypoint markers ────────────────────────────────────────────────

function _vizPlaceWaypointMarkers() {
  if (!vizMapState.mapInstance) return;
  var map = vizMapState.mapInstance.getMap();
  if (!map) return;
  /* Tear down existing */
  for (var i = 0; i < 3; i++) {
    (vizMapState.waypointMarkers[i] || []).forEach(function(m){ try { m.remove(); } catch(e){} });
    vizMapState.waypointMarkers[i] = [];
  }
  /* Rebuild from MapView's waypoints (lonlat) */
  var colors = ['#f1c40f', '#e67e22', '#3498db'];
  for (var p = 0; p < 3; p++) {
    if (!vizPathVisible[p]) continue;
    var wps = vizMapState.mapInstance.getWaypoints(p);
    for (var j = 0; j < wps.length; j++) (function(pIdx, wIdx, ll, color){
      var el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;border:2px solid #fff;'
        + 'background:' + color + ';box-shadow:0 0 4px rgba(0,0,0,.6);cursor:grab';
      var marker = new window.maplibregl.Marker({ element: el, draggable: true })
        .setLngLat(ll).addTo(map);
      marker.on('dragend', function(){
        var pos = marker.getLngLat();
        _vizUpdateWaypointPosition(pIdx, wIdx, [pos.lng, pos.lat]);
      });
      vizMapState.waypointMarkers[pIdx].push(marker);
    })(p, j, wps[j], colors[p]);
  }
}

function _vizUpdateWaypointPosition(pathIdx, wpIdx, lngLat) {
  var hole = _vizCurHoleGeo();
  var axis = _vizHoleAxis(hole);
  if (!axis) return;
  var frame = _vizLngLatToFrame(axis, lngLat);
  _vizEnsureHoleEdit();
  vizHoleEdits[vizSelectedHole].waypoints[pathIdx][wpIdx] = frame;
  /* Update MapView's lonlat copy so its chain renders correctly */
  var allWps = vizMapState.mapInstance.getWaypoints(pathIdx);
  allWps[wpIdx] = lngLat;
  vizMapState.mapInstance.setWaypoints(pathIdx, allWps);
  _vizMapRenderAskb();
  _vizMapRenderChainPanel();
}

// ── VIZMAP-2: Ask-B overlay ───────────────────────────────────────────────────

function _vizMapEnsureAskbLayer() {
  if (!vizMapState.mapInstance) return;
  var canvas = document.getElementById('vizMapCanvas');
  if (!canvas) return;
  if (vizMapState.askbSvg && canvas.contains(vizMapState.askbSvg)) return;
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'vizMapAskbSvg';
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10');
  canvas.appendChild(svg);
  vizMapState.askbSvg = svg;
  /* Bind move/zoom listener once. */
  var map = vizMapState.mapInstance.getMap();
  if (map && !vizMapState._askbMoveBound) {
    map.on('move', _vizMapRepositionAskb);
    vizMapState._askbMoveBound = true;
  }
}

function _vizMapRenderAskb() {
  if (!vizMapState.askbSvg) return;
  if (vizMapState.askbMode === 'none') { vizMapState.askbSvg.innerHTML = ''; return; }
  if (!vizMapState.mapInstance) return;
  var map = vizMapState.mapInstance.getMap();
  if (!map) return;
  var hcp = getHandicap() || 25;
  var handed = profile.handed || 'Right-handed';
  var html = '';
  for (var p = 0; p < 3; p++) {
    if (!vizPathVisible[p]) continue;
    var wps = vizMapState.mapInstance.getWaypoints(p);
    var clubs = vizPaths[p];
    for (var j = 0; j < wps.length; j++) {
      var clubId = clubs[j];
      if (!clubId) continue;
      var club = bag.find(function(c){ return c.id === clubId; });
      if (!club) continue;
      var disp = vizGetDisp(club, hcp, handed, profile.yardType||'Total', vizYardMode);
      if (!disp || !disp.carry) continue;
      var pt = map.project(wps[j]);
      /* Yards-to-pixels scale: project a point 1 yard north of waypoint and measure. */
      var ll1 = window.turf.destination(window.turf.point(wps[j]), 1, 0, { units:'yards' }).geometry.coordinates;
      var pt1 = map.project(ll1);
      var pxPerYd = Math.hypot(pt1.x - pt.x, pt1.y - pt.y);
      if (!isFinite(pxPerYd) || pxPerYd <= 0) continue;
      var color = ['#f1c40f','#e67e22','#3498db'][p];
      if (vizMapState.askbMode === 'ellipse' && askbShow.calc) {
        html += '<g transform="translate(' + pt.x + ',' + pt.y + ')">'
          + vizRenderEllipse(p*10+j, 0, 0,
              disp.rxR*pxPerYd, disp.rxL*pxPerYd, disp.dl*pxPerYd, disp.ds*pxPerYd,
              disp.tilt, color, disp.pR, disp.pL, disp.pS, disp.pLn, vizDisplayMode)
          + '</g>';
      } else if (vizMapState.askbMode === 'radial') {
        var obs = askbGetObserved(club);
        if (obs) {
          var refR = ((disp.latH + (disp.dl + disp.ds)/2) / 2) * pxPerYd * 0.85;
          html += '<g transform="translate(' + pt.x + ',' + pt.y + ')">'
            + vizRenderObservedMarker(0, 0, refR, obs, color)
            + '</g>';
        }
      }
    }
  }
  vizMapState.askbSvg.innerHTML = html;
}

function _vizMapRepositionAskb() {
  /* Re-run full render — innerHTML swap is cheap and projection cost dominates. */
  _vizMapRenderAskb();
}

// ── VIZMAP-2: chain panel ─────────────────────────────────────────────────────

function _vizMapRenderChainPanel() {
  var el = document.getElementById('vizMapChainPanel');
  if (!el) return;
  var colors = ['#f1c40f', '#e67e22', '#3498db'];
  var pathNames = ['P1', 'P2', 'P3'];
  var shelfIds = vizSelectedClubs.size ? vizSelectedClubs : new Set(bag.filter(function(c){ return c.tested && c.type !== 'Putter'; }).map(function(c){ return c.id; }));
  var allClubs = bag.filter(function(c){ return c.tested && c.type !== 'Putter'; });
  var clubOpts = '<option value="">\u2014 pick club \u2014</option>'
    + allClubs.map(function(c){ return '<option value="' + c.id + '">' + escHtml(c.identifier||c.type) + '</option>'; }).join('');

  var hole = _vizCurHoleGeo();
  var axis = _vizHoleAxis(hole);

  var html = '';
  for (var p = 0; p < 3; p++) {
    if (!vizPathVisible[p]) continue;
    var col = colors[p];
    var isActive = vizMapState.activePath === p;
    var wps = vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(p) : [];
    var clubs = vizPaths[p];

    html += '<div style="margin-bottom:8px;border-left:3px solid ' + col + ';padding-left:8px">';
    html += '<div style="font-size:.62rem;font-weight:700;color:' + col + ';margin-bottom:4px">' + pathNames[p] + (isActive ? ' \u25c4 active' : '') + '</div>';

    /* Shot rows */
    for (var s = 0; s < wps.length; s++) {
      var clubId = clubs[s] || '';
      var distYds = '';
      if (axis) {
        var edit = vizHoleEdits[vizSelectedHole];
        var fw = edit && edit.waypoints && edit.waypoints[p];
        if (fw && fw[s]) {
          if (s === 0) {
            distYds = Math.round(Math.sqrt(fw[s].alongYds*fw[s].alongYds + fw[s].offsetYds*fw[s].offsetYds)) + 'y';
          } else if (fw[s-1]) {
            var da = fw[s].alongYds - fw[s-1].alongYds;
            var do_ = fw[s].offsetYds - fw[s-1].offsetYds;
            distYds = Math.round(Math.sqrt(da*da + do_*do_)) + 'y';
          }
        }
      }
      html += '<div id="vizMapChainRow-' + p + '-' + s + '" style="display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:.62rem">';
      html += '<span style="color:var(--tx3);min-width:18px">' + (s+1) + '.</span>';
      html += '<select onchange="vizUpdatePath(' + p + ',' + s + ',this.value)" style="font-size:.62rem;min-width:90px">' + clubOpts + '</select>';
      if (distYds) html += '<span style="color:var(--tx3);font-size:.58rem">' + distYds + '</span>';
      html += '<button onclick="_vizMapRemoveShot(' + p + ',' + s + ')" style="font-size:.6rem;padding:1px 5px;background:transparent;border:1px solid var(--br);border-radius:3px;cursor:pointer;color:var(--tx3)">\u00D7</button>';
      html += '</div>';
    }

    /* Next shot picker (active path only) */
    if (isActive) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">';
      html += '<select onchange="_vizMapPickClubForActivePath(this.value);this.value=\'\'" style="font-size:.62rem;min-width:90px">' + clubOpts + '</select>';
      if (vizMapState.pendingClubs[p]) {
        var pendClub = bag.find(function(c){ return c.id === vizMapState.pendingClubs[p]; });
        html += '<span style="font-size:.58rem;color:var(--tx3)">Tap map \u2192 ' + escHtml(pendClub ? (pendClub.identifier||pendClub.type) : '') + '</span>';
      }
      html += '<button onclick="_vizMapClearActivePath()" style="font-size:.6rem;padding:1px 5px;background:transparent;border:1px solid var(--br);border-radius:3px;cursor:pointer;color:var(--tx3)">Clear</button>';
      html += '</div>';
    }

    html += '</div>';
  }

  el.innerHTML = html || '<div style="font-size:.62rem;color:var(--tx3);padding:4px">No paths visible.</div>';

  /* Set select values after render */
  for (var p2 = 0; p2 < 3; p2++) {
    var clubs2 = vizPaths[p2];
    for (var s2 = 0; s2 < clubs2.length; s2++) {
      var row = document.getElementById('vizMapChainRow-' + p2 + '-' + s2);
      if (row) {
        var sel = row.querySelector('select');
        if (sel) sel.value = clubs2[s2] || '';
      }
    }
  }
}

// ── VIZMAP-2: panel HTML ──────────────────────────────────────────────────────

function _vizMapStyleToggleHtml() {
  var m = vizMapState.styleMode;
  return '<div style="display:flex;gap:3px">'
    + '<button onclick="_vizMapSetStyle(\'satellite\')" style="font-size:.6rem;padding:3px 8px;border-radius:4px 0 0 4px;border:1px solid var(--br);cursor:pointer;background:' + (m==='satellite'?'var(--gr3)':'var(--bg)') + ';color:' + (m==='satellite'?'var(--ac2)':'var(--tx2)') + '">Satellite</button>'
    + '<button onclick="_vizMapSetStyle(\'plain\')" style="font-size:.6rem;padding:3px 8px;border-radius:0 4px 4px 0;border:1px solid var(--br);border-left:none;cursor:pointer;background:' + (m==='plain'?'var(--gr3)':'var(--bg)') + ';color:' + (m==='plain'?'var(--ac2)':'var(--tx2)') + '">Plain</button>'
    + '</div>';
}

function _vizMapAskbToggleHtml() {
  var m = vizMapState.askbMode;
  return '<div style="display:flex;gap:3px">'
    + '<button onclick="_vizMapSetAskb(\'ellipse\')" style="font-size:.6rem;padding:3px 8px;border-radius:4px 0 0 4px;border:1px solid var(--br);cursor:pointer;background:' + (m==='ellipse'?'var(--gr3)':'var(--bg)') + ';color:' + (m==='ellipse'?'var(--ac2)':'var(--tx2)') + '">Ellipse</button>'
    + '<button onclick="_vizMapSetAskb(\'radial\')" style="font-size:.6rem;padding:3px 8px;border-radius:0;border:1px solid var(--br);border-left:none;cursor:pointer;background:' + (m==='radial'?'var(--gr3)':'var(--bg)') + ';color:' + (m==='radial'?'var(--ac2)':'var(--tx2)') + '">Radial</button>'
    + '<button onclick="_vizMapSetAskb(\'none\')" style="font-size:.6rem;padding:3px 8px;border-radius:0 4px 4px 0;border:1px solid var(--br);border-left:none;cursor:pointer;background:' + (m==='none'?'var(--gr3)':'var(--bg)') + ';color:' + (m==='none'?'var(--ac2)':'var(--tx2)') + '">None</button>'
    + '</div>';
}

function _vizMapActivePathRadioHtml() {
  var colors = ['#f1c40f', '#e67e22', '#3498db'];
  var html = '<div style="display:flex;gap:4px;margin-left:auto">';
  for (var i = 0; i < 3; i++) {
    var isActive = vizMapState.activePath === i;
    var isVis = vizPathVisible[i];
    html += '<div style="display:flex;align-items:center;gap:2px">'
      + '<button onclick="_vizMapTogglePathVis(' + i + ')" style="width:10px;height:10px;border-radius:50%;border:2px solid ' + colors[i] + ';background:' + (isVis?colors[i]:'transparent') + ';cursor:pointer;padding:0" title="Toggle P' + (i+1) + '"></button>'
      + '<button onclick="_vizMapSetActivePath(' + i + ')" style="font-size:.58rem;padding:2px 6px;border-radius:4px;border:1px solid var(--br);cursor:pointer;background:' + (isActive?'var(--gr3)':'var(--bg)') + ';color:' + (isActive?'var(--ac2)':'var(--tx2)') + '">P' + (i+1) + '</button>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

function _vizMapEnsurePanel() {
  /* Ensure #vizMapPanel exists as a sibling of #vizSvgCard. Create once. */
  if (document.getElementById('vizMapPanel')) return;
  var card = document.getElementById('vizSvgCard');
  if (!card || !card.parentNode) return;
  var div = document.createElement('div');
  div.id = 'vizMapPanel';
  div.style.display = 'none';
  card.parentNode.insertBefore(div, card.nextSibling);
}

function _vizMapPanelHtml() {
  var st = vizMapState.fetchStatus;
  if (st === 'idle') {
    return '<div style="padding:12px;text-align:center"><button class="btn" onclick="_vizMapLoadClick()">Load map for this course</button></div>';
  }
  if (st === 'loading') {
    return '<div style="padding:12px;text-align:center;color:var(--tx3);font-size:.7rem">Loading map\u2026</div>';
  }
  if (st === 'failed') {
    return '<div style="padding:12px;text-align:center;color:var(--danger);font-size:.7rem">Map load failed: '
      + escHtml(vizMapState.fetchError || 'unknown')
      + '<br><button class="btn sec" style="margin-top:6px" onclick="_vizMapLoadClick()">Retry</button></div>';
  }
  /* loaded */
  var hole = _vizCurHoleGeo();
  var holeBanner = (!hole || !hole.tee || !hole.green)
    ? '<div style="padding:6px 8px;font-size:.62rem;color:var(--danger)">Map data missing for this hole.</div>'
    : '';
  return '<div style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--br)">'
    +   _vizMapStyleToggleHtml()
    +   _vizMapAskbToggleHtml()
    +   _vizMapActivePathRadioHtml()
    + '</div>'
    + holeBanner
    + '<div id="vizMapCanvas" style="position:relative;width:100%;height:60vh;background:#111"></div>'
    + '<div id="vizMapChainPanel" style="padding:6px 8px"></div>';
}

function _vizMapRenderPanel() {
  if (vizHoleViewMode !== 'map' || vizMode !== 'hole') return;
  _vizMapEnsurePanel();
  var panel = document.getElementById('vizMapPanel');
  if (!panel) return;

  /* Show map panel, hide SVG card */
  panel.style.display = 'block';
  var card = document.getElementById('vizSvgCard');
  if (card) card.style.display = 'none';

  /* If loaded and canvas already in place, just refresh in-place controls. */
  var canvas = document.getElementById('vizMapCanvas');
  if (vizMapState.fetchStatus === 'loaded' && canvas) {
    _vizMapRenderChainPanel();
    _vizMapRenderAskb();
    return;
  }

  /* Replace panel content (loading/failed/idle states, or first loaded render). */
  if (vizMapState.mapInstance) {
    _vizMapUnmount();
  }
  panel.innerHTML = _vizMapPanelHtml();

  if (vizMapState.fetchStatus === 'loaded') {
    _vizMapMount();
    _vizMapRenderChainPanel();
  }
}

// ── VIZMAP-2: lifecycle ───────────────────────────────────────────────────────

function _vizMapUnmount() {
  if (vizMapState.mapInstance) {
    try { vizMapState.mapInstance.unmount(); } catch(e) {}
    vizMapState.mapInstance = null;
  }
  /* Clear viz-managed markers */
  for (var i = 0; i < 3; i++) {
    (vizMapState.waypointMarkers[i] || []).forEach(function(m){ try { m.remove(); } catch(e){} });
    vizMapState.waypointMarkers[i] = [];
  }
  if (vizMapState.askbSvg && vizMapState.askbSvg.parentNode) {
    vizMapState.askbSvg.parentNode.removeChild(vizMapState.askbSvg);
  }
  vizMapState.askbSvg = null;
  vizMapState._askbMoveBound = false;
  vizMapState.teeOverride = null;
  vizMapState.pendingClubs = [null, null, null];
}

function _vizMapMount() {
  if (!vizMapState.geo) return;
  if (!vizMapState.mapInstance) {
    vizMapState.mapInstance = new MapView({
      containerId: 'vizMapCanvas',
      geo:         vizMapState.geo,
      holeN:       vizSelectedHole,
      idPrefix:    'viz',
      multiAim:    true,
      styleMode:   vizMapState.styleMode,
      onMapClick:  function(){},  /* click handled via onWaypointsChange */
      onTeeChange: function(ll) {
        vizMapState.teeOverride = ll;
        _vizSyncWaypointsToMap();
        _vizPlaceWaypointMarkers();
        _vizMapRenderAskb();
        _vizMapRenderChainPanel();
      },
      onWaypointsChange: _vizMapOnWaypointsChange
    });
  } else {
    vizMapState.mapInstance.setGeometry(vizMapState.geo);
    vizMapState.mapInstance.showHole(vizSelectedHole, { resetAim: false });
  }
  /* Sync waypoints from vizHoleEdits into MapView (frame -> lonlat). */
  _vizSyncWaypointsToMap();
  vizMapState.mapInstance.setActivePathIdx(vizMapState.activePath);
  for (var i = 0; i < 3; i++) {
    vizMapState.mapInstance.setPathVisible(i, !!vizPathVisible[i]);
  }
  vizMapState.mapInstance.mount();
  /* Place per-waypoint draggable markers. */
  _vizPlaceWaypointMarkers();
  /* Build/refresh the SVG overlay for Ask-B. */
  _vizMapEnsureAskbLayer();
  _vizMapRenderAskb();
}

function _vizMapOnWaypointsChange(pathIdx, newArr) {
  var prev = vizMapState._lastWaypointCounts || [0,0,0];
  var added = newArr.length > (prev[pathIdx] || 0);
  if (added) {
    var pending = vizMapState.pendingClubs[pathIdx];
    if (!pending) {
      /* No club pre-selected — reject the add. */
      vizMapState.mapInstance.removeWaypoint(pathIdx, newArr.length - 1);
      _vizMapToast('Pick a club first');
      /* Recalibrate counts after undo */
      vizMapState._lastWaypointCounts = [
        vizMapState.mapInstance.getWaypoints(0).length,
        vizMapState.mapInstance.getWaypoints(1).length,
        vizMapState.mapInstance.getWaypoints(2).length
      ];
      return;
    }
    /* Commit: store waypoint in frame coords, append clubId. */
    var hole = _vizCurHoleGeo();
    var axis = _vizHoleAxis(hole);
    if (!axis) {
      vizMapState.mapInstance.removeWaypoint(pathIdx, newArr.length - 1);
      vizMapState._lastWaypointCounts = [
        vizMapState.mapInstance.getWaypoints(0).length,
        vizMapState.mapInstance.getWaypoints(1).length,
        vizMapState.mapInstance.getWaypoints(2).length
      ];
      return;
    }
    var lngLat = newArr[newArr.length - 1];
    var frame  = _vizLngLatToFrame(axis, lngLat);
    _vizEnsureHoleEdit();
    vizHoleEdits[vizSelectedHole].waypoints[pathIdx].push(frame);
    vizPaths[pathIdx].push(pending);
    vizMapState.pendingClubs[pathIdx] = null;
  }
  /* Recalibrate counts */
  vizMapState._lastWaypointCounts = [
    vizMapState.mapInstance.getWaypoints(0).length,
    vizMapState.mapInstance.getWaypoints(1).length,
    vizMapState.mapInstance.getWaypoints(2).length
  ];
  _vizPlaceWaypointMarkers();
  _vizMapRenderAskb();
  _vizMapRenderChainPanel();
  renderViz();
}

// ── VIZMAP-2: loader ──────────────────────────────────────────────────────────

async function _vizMapLoad() {
  if (!vizActiveCourse) return;
  var c = vizActiveCourse;
  if (vizMapState.fetchStatus === 'loading') return;  /* dedupe */

  if (c.osmCourseId || c.osmCenter) {
    vizMapState.fetchStatus = 'loading';
    vizMapState.fetchError = null;
    _vizMapRenderPanel();
    try {
      var geo;
      if (c.osmCourseId) {
        try {
          geo = await geomLoadByCourse(c.osmCourseId, c.osmCenter || null);
        } catch (e) {
          /* VIZMAP-2 fix: any geomLoadByCourse failure (bad-format id,
             no boundary, network/timeout, etc.) falls back to geomLoadByCenter
             when osmCenter is present. The narrow NO_COURSE_BOUNDARY filter
             was over-strict.
             Original (commented out, do not delete):
             if (e && e.message === 'NO_COURSE_BOUNDARY' && c.osmCenter) {
               console.warn('[viz] No course boundary; falling back to radial fetch.');
               geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500);
             } else {
               throw e;
             }
          */
          if (c.osmCenter) {
            console.warn('[viz] geomLoadByCourse failed (' + (e && e.message) + '); radial fallback.');
            geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500);
          } else {
            throw e;
          }
        }
      } else if (c.osmCenter) {
        /* osmCenter only — radial fetch directly, matching live-round legacy path */
        geo = await geomLoadByCenter(c.osmCenter[0], c.osmCenter[1], 1500);
      }
      if (!geo || !geo.holes || !Object.keys(geo.holes).length) {
        throw new Error('No hole geometry found');
      }
      vizMapState.geo = geo;
      vizMapState.fetchStatus = 'loaded';
      _vizMapRenderPanel();
    } catch (err) {
      vizMapState.fetchStatus = 'failed';
      vizMapState.fetchError = (err && err.message) || 'unknown';
      _vizMapRenderPanel();
    }
  } else {
    /* Unpinned — open locate modal. */
    geomOpenLocateModal({
      course: c,
      onSelect: function(osmId, center) {
        vizMapState.fetchStatus = 'loading';
        vizMapState.fetchError = null;
        _vizMapRenderPanel();
        (async function(){
          try {
            var geo = await geomLoadByCourse(osmId, center || null);
            if (!geo || !geo.holes || !Object.keys(geo.holes).length) {
              if (center) geo = await geomLoadByCenter(center[0], center[1], 1500);
            }
            if (!geo || !geo.holes || !Object.keys(geo.holes).length) {
              throw new Error('No hole geometry found');
            }
            vizMapState.geo = geo;
            vizMapState.fetchStatus = 'loaded';
            _vizMapRenderPanel();
          } catch (err) {
            vizMapState.fetchStatus = 'failed';
            vizMapState.fetchError = (err && err.message) || 'unknown';
            _vizMapRenderPanel();
          }
        })();
      },
      onSkip: function() {}
    });
  }
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
    /* ASKB-3 -- attach club back-ref to disp so vizDrawCanvas can resolve observed overlay. */
    const disps=clubs.map(c=>{ const d=vizGetDisp(c,hcp,handed,profile.yardType||'Total',vizYardMode); if(d) d._club=c; return d; }).filter(Boolean);
    const title=vizClubSrc==='optimised'?'Optimised bag · HCP '+hcp:'Custom · HCP '+hcp;
    const maxRange=+document.getElementById('vizMaxRange')?.value||calcVizMaxRange();
    const interval=+document.getElementById('vizRangeInterval')?.value||25;
    vizDrawCanvas(disps,fwYds,mode,title,'',maxRange,interval);
  } else {
    // hole planning — update note strip
    /* VIZMAP-2 -- inject Synthetic/Map toggle into hole controls */
    (function(){
      var toggleId = 'vizHoleViewToggle';
      var ctrl = document.getElementById('vizHoleControls');
      if (ctrl && !document.getElementById(toggleId)) {
        var div = document.createElement('div');
        div.id = toggleId;
        div.style.cssText = 'display:flex;gap:3px;margin-bottom:6px';
        ctrl.insertBefore(div, ctrl.firstChild);
      }
      var tog = document.getElementById(toggleId);
      if (tog) {
        tog.innerHTML = '<button onclick="_vizSetHoleViewMode(\'synthetic\')" style="font-size:.6rem;padding:3px 8px;border-radius:4px 0 0 4px;border:1px solid var(--br);cursor:pointer;background:' + (vizHoleViewMode==='synthetic'?'var(--gr3)':'var(--bg)') + ';color:' + (vizHoleViewMode==='synthetic'?'var(--ac2)':'var(--tx2)') + '">Synthetic</button>'
          + '<button onclick="_vizSetHoleViewMode(\'map\')" style="font-size:.6rem;padding:3px 8px;border-radius:0 4px 4px 0;border:1px solid var(--br);border-left:none;cursor:pointer;background:' + (vizHoleViewMode==='map'?'var(--gr3)':'var(--bg)') + ';color:' + (vizHoleViewMode==='map'?'var(--ac2)':'var(--tx2)') + '">Map</button>';
      }
    })();
    /* VIZMAP-2 -- map mode: render map panel instead of SVG planner */
    if (vizHoleViewMode === 'map') {
      var _svgCard = document.getElementById('vizSvgCard');
      if (_svgCard) _svgCard.style.display = 'none';
      _vizMapRenderPanel();
      return;
    }
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
  askbSyncButtons(); /* ASKB-4 */
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
  /* VIZMAP-2 -- course change: unmount map, clear geo, clear waypoints (frame coords are course-specific) */
  if (vizMapState.mapInstance || vizMapState.geo) {
    _vizMapUnmount();
    vizMapState.geo = null;
    vizMapState.fetchStatus = 'idle';
    vizMapState.fetchError = null;
  }
  Object.keys(vizHoleEdits).forEach(function(h){
    if (vizHoleEdits[h] && vizHoleEdits[h].waypoints) {
      vizHoleEdits[h].waypoints = [[],[],[]];
    }
  });
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
  /* VIZMAP-2 -- preserve existing waypoints field if present */
  var existingWaypoints = vizHoleEdits[vizSelectedHole] && vizHoleEdits[vizSelectedHole].waypoints;
  vizHoleEdits[vizSelectedHole]={
    paths:vizPaths.map(p=>[...p]),
    visible:[...vizPathVisible],
    waypoints: existingWaypoints || [[],[],[]]
  };
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
    id:uid(), date:localISO().slice(0,10), /* CLEAN11 */
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
    id:uid(), date:localISO().slice(0,10), /* CLEAN11 */
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
  /* VIZMAP-2 -- propagate to map if mounted */
  if (vizHoleViewMode === 'map' && vizMapState.mapInstance) {
    vizMapState.mapInstance.setPathVisible(pi, vizPathVisible[pi]);
    _vizPlaceWaypointMarkers();
    _vizMapRenderAskb();
    _vizMapRenderChainPanel();
  }
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
  /* VIZMAP-2 -- sync map to new hole if map mode active */
  if (vizHoleViewMode === 'map' && vizMapState.mapInstance && vizMapState.geo) {
    vizMapState.teeOverride = null; /* new hole = new tee */
    vizMapState.mapInstance.showHole(n, { resetAim: false });
    _vizSyncWaypointsToMap();
    _vizPlaceWaypointMarkers();
    _vizMapRenderAskb();
    _vizMapRenderChainPanel();
  }
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
  askbSyncButtons(); /* ASKB-4 */
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

function _buildDispRadialSVG(heatCounts, heatMax, fpCounts, expectedOverlay, showHeat){
  var cx=150, cy=150;
  var rB=ZONE_RING_RADII.bull, rI=ZONE_RING_RADII.inner, rO=ZONE_RING_RADII.outer;
  var bg='<rect width="300" height="300" fill="#6a9a50"/><rect x="90" y="0" width="120" height="300" fill="#9ec880"/>';
  /* ASKB-4 -- showHeat=false suppresses heat fill + % labels; expectedOverlay still renders if provided */
  var heatOn = showHeat !== false;
  var heatR=function(n){
    if(!heatOn) return 'rgba(255,255,255,0.08)';
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
  if(heatOn && total>0){
    var lbl=function(pct,x,y){ return pct>0?'<text x="'+x+'" y="'+y+'" font-family="monospace" font-size="9" fill="white" text-anchor="middle">'+pct+'%</text>':''; };
    var iMid=(rB+rI)/2, oMid=(rI+rO)/2;
    labels+=lbl(Math.round((heatCounts['bull']||0)/total*100),150,154);
    var _fpLine=function(segKey,segCount,x,y){
      if(!fpCounts||!segCount) return '';
      var sfp=fpCounts[segKey]; if(!sfp) return '';
      var parts=[];
      if(sfp.straight>0)         parts.push('\u2191'+Math.round(sfp.straight/segCount*100)+'%');
      if(sfp['left-to-right']>0) parts.push('\u21b1'+Math.round(sfp['left-to-right']/segCount*100)+'%');
      if(sfp['right-to-left']>0) parts.push('\u21b0'+Math.round(sfp['right-to-left']/segCount*100)+'%');
      if(!parts.length) return '';
      return '<text x="'+x+'" y="'+(parseFloat(y)+10)+'" font-family="monospace" font-size="7" fill="white" text-anchor="middle">'+parts.join(' ')+'</text>';
    };
    for(i=0;i<8;i++){
      var ang=i*45*Math.PI/180;
      var ix=(cx+iMid*Math.sin(ang)).toFixed(1),iy=(cy-iMid*Math.cos(ang)+3).toFixed(1);
      var ox=(cx+oMid*Math.sin(ang)).toFixed(1),oy=(cy-oMid*Math.cos(ang)+3).toFixed(1);
      labels+=lbl(Math.round((heatCounts['inner-'+i]||0)/total*100),ix,iy);
      labels+=_fpLine('inner-'+i,heatCounts['inner-'+i]||0,ix,iy);
      labels+=lbl(Math.round((heatCounts['outer-'+i]||0)/total*100),ox,oy);
      labels+=_fpLine('outer-'+i,heatCounts['outer-'+i]||0,ox,oy);
    }
  }
  /* ASKB-2 -- expected-ellipse outline overlay, projected onto radial canvas.
     expectedOverlay = { rxR, rxL, ryU, ryD, tilt } in yards; scaled so mean-radius maps to rO. */
  var overlay='';
  if(expectedOverlay){
    var eo=expectedOverlay;
    var meanR=(eo.rxR+eo.rxL+eo.ryU+eo.ryD)/4;
    if(meanR>0){
      var scl=rO/meanR;
      var ep=vizEllipsePath(cx,cy,eo.rxR*scl,eo.rxL*scl,eo.ryU*scl,eo.ryD*scl,eo.tilt||0);
      overlay='<path d="'+ep+'" fill="none" stroke="rgba(255,235,120,0.95)" stroke-width="1.8" stroke-dasharray="4 3" opacity="0.9"/>';
      overlay+='<text x="'+cx+'" y="'+(cy+rO+12)+'" font-family="monospace" font-size="8" fill="rgba(255,235,120,0.9)" text-anchor="middle">expected</text>';
    }
  }
  return '<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:280px;display:block;margin:0 auto">'+bg+paths+labels+overlay+'</svg>';
}

function _lrShotClubName(shot){
  /* SLUG2 -- slug-first lookup; clubId fallback; stored clubName fallback */
  var c=(shot.clubSlug&&bag.find(function(x){return x.slug===shot.clubSlug;}))||bag.find(function(x){return x.id===shot.clubId;});
  return c?(c.identifier||c.type):(shot.clubName||(shot.clubId||'Unknown'));
}

export function initVizDisp(){
  if(vizDispInitDone){ renderVizDisp(); return; }
  vizDispInitDone=true;
  vizDispSelectedSessions=new Set((rangeSessions||[]).filter(function(s){ return s.committed; }).map(function(s){ return s.sessionId; }));
  _buildDispSessionShelf();
  vizDispSelectedRounds=new Set(
    (rounds||[]).reduce(function(acc,r,i){
      if(!r) return acc;
      var hasShots=(r.holes||[]).some(function(h){
        return (h.shots||[]).some(function(s){ return s&&s.radial_ring; });
      });
      if(hasShots) acc.push(i);
      return acc;
    },[])
  );
  _buildDispRoundShelf();
  _buildDispClubShelf();
  renderVizDisp();
}

var _DISP_TYPE_ORDER=['driver','wood','hybrid','iron','wedge'];
function _dispClubSortKey(n){
  n=(n||'').toLowerCase();
  for(var i=0;i<_DISP_TYPE_ORDER.length;i++){ if(n.indexOf(_DISP_TYPE_ORDER[i])!==-1) return i; }
  return _DISP_TYPE_ORDER.length;
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

function _buildDispRoundShelf(){
  var shelf=document.getElementById('vizDispRoundShelf');
  if(!shelf) return;
  var eligible=(rounds||[]).map(function(r,i){ return {r:r,i:i}; }).filter(function(obj){
    return (obj.r.holes||[]).some(function(h){
      return (h.shots||[]).some(function(s){ return s.radial_ring; });
    });
  });
  if(!eligible.length){
    shelf.innerHTML='<span style="font-size:.62rem;color:var(--tx3)">No rounds with shot data yet.</span>';
    return;
  }
  shelf.innerHTML=eligible.map(function(obj,i){
    var r=obj.r, idx=obj.i;
    var on=vizDispSelectedRounds.has(idx);
    var shotCount=(r.holes||[]).reduce(function(acc,h){
      return acc+((h.shots||[]).filter(function(s){ return s.radial_ring; }).length);
    },0);
    var col=VIZ_COLORS[(i+20)%VIZ_COLORS.length];
    return '<label onclick="vizDispToggleRound('+idx+')" id="vdround-'+idx+'"'+
      ' style="display:flex;align-items:center;gap:5px;padding:4px 9px;'+
      'background:'+(on?'var(--gr3)':'var(--bg)')+';border:1px solid '+(on?'var(--gr2)':'var(--br)')+';'+
      'border-radius:4px;cursor:pointer;font-size:.62rem;transition:all .15s">'+
      '<div style="width:8px;height:8px;border-radius:2px;background:'+col+';flex-shrink:0"></div>'+
      escHtml(fmtDate(r.date))+(r.courseName?' \u00B7 '+escHtml(r.courseName):'')+
      ' <span style="color:var(--tx3);font-size:.56rem">'+shotCount+' shot'+(shotCount!==1?'s':'')+'</span>'+
      '</label>';
  }).join('');
}

function _buildDispClubShelf(){
  var shelf=document.getElementById('vizDispClubShelf');
  if(!shelf) return;
  /* SLUG2b -- key by slug (fallback clubName for legacy entries). Name resolved at render. */
  var slugMap={};
  function _keyFor(cs){ return cs.clubSlug||cs.clubName||cs.clubId; }
  function _nameFor(key, fallback){
    var c=bag.find(function(x){return x.slug===key;});
    if(c) return c.identifier||c.type;
    return fallback||key;
  }
  (rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); }).forEach(function(s){
    (s.clubSummary||[]).forEach(function(cs){
      var key=_keyFor(cs);
      if(!slugMap[key]) slugMap[key]={ key:key, displayName:_nameFor(key, cs.clubName), totalShots:0 };
      (cs.targets||[]).forEach(function(t){ slugMap[key].totalShots+=t.shotCount||0; });
    });
  });
  // Round pass — aggregate by slug from selected rounds (fallback clubName)
  (rounds||[]).forEach(function(r,idx){
    if(!vizDispSelectedRounds.has(idx)) return;
    (r.holes||[]).forEach(function(h){
      (h.shots||[]).forEach(function(shot){
        if(!shot.radial_ring) return;
        var key=shot.clubSlug||_lrShotClubName(shot);
        if(!slugMap[key]) slugMap[key]={ key:key, displayName:_nameFor(key, _lrShotClubName(shot)), totalShots:0 };
        slugMap[key].totalShots++;
      });
    });
  });
  var keys=Object.keys(slugMap);
  if(!keys.length){
    shelf.innerHTML='<span style="font-size:.62rem;color:var(--tx3)">No sessions selected.</span>';
    vizDispSelectedKeys=new Set();
    return;
  }
  vizDispSelectedKeys=new Set(keys);
  shelf.innerHTML=keys.map(function(key,i){
    var cm=slugMap[key];
    var col=VIZ_COLORS[i%VIZ_COLORS.length];
    var safeId='vdclub-'+key.replace(/[^a-zA-Z0-9]/g,'-');
    return '<label onclick="vizDispToggleClub(\''+key.replace(/'/g,"\\'")+'\')" id="'+safeId+'"'+
      ' style="display:flex;align-items:center;gap:5px;padding:4px 9px;'+
      'background:var(--gr3);border:1px solid var(--gr2);'+
      'border-radius:4px;cursor:pointer;font-size:.62rem;transition:all .15s">'+
      '<div style="width:8px;height:8px;border-radius:2px;background:'+col+';flex-shrink:0"></div>'+
      escHtml(cm.displayName)+
      ' <span style="color:var(--tx3);font-size:.56rem">'+cm.totalShots+' shot'+(cm.totalShots!==1?'s':'')+'</span>'+
      '</label>';
  }).join('');
}

// Aggregate dispersion counts by key (slug preferred, clubName fallback) across selected sessions, optionally filtered to one yardage
/* SLUG2b -- param renamed clubName->key; matches clubSlug first, then clubName */
function _aggregateDispCounts(key, selectedSessions, yardageFilter){
  var counts={ bull:0 };
  var i;
  for(i=0;i<8;i++){ counts['inner-'+i]=0; counts['outer-'+i]=0; }
  var fp={ straight:0, 'left-to-right':0, 'right-to-left':0 };
  var fpCounts={bull:{straight:0,'left-to-right':0,'right-to-left':0}};
  for(i=0;i<8;i++){ fpCounts['inner-'+i]={straight:0,'left-to-right':0,'right-to-left':0}; fpCounts['outer-'+i]={straight:0,'left-to-right':0,'right-to-left':0}; }
  var totalShots=0;
  selectedSessions.forEach(function(s){
    /* SLUG2b -- match by clubSlug first, fall back to clubName for legacy entries */
    var cs=(s.clubSummary||[]).find(function(x){ return (x.clubSlug||x.clubName||x.clubId)===key; });
    if(!cs) return;
    (cs.targets||[]).forEach(function(t){
      if(yardageFilter!==null && yardageFilter!==undefined && t.yardage!==yardageFilter) return;
      var d=t.dispersion;
      totalShots+=t.shotCount||0;
      counts.bull+=d.bull.total||0;
      Object.keys(d.bull.flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.bull.flightPaths[fp2]||0; if(fpCounts.bull[fp2]!==undefined) fpCounts.bull[fp2]+=d.bull.flightPaths[fp2]||0; });
      for(i=0;i<8;i++){
        if(d.inner[i]){ counts['inner-'+i]+=d.inner[i].total||0; Object.keys(d.inner[i].flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.inner[i].flightPaths[fp2]||0; if(fpCounts['inner-'+i][fp2]!==undefined) fpCounts['inner-'+i][fp2]+=d.inner[i].flightPaths[fp2]||0; }); }
        if(d.outer[i]){ counts['outer-'+i]+=d.outer[i].total||0; Object.keys(d.outer[i].flightPaths||{}).forEach(function(fp2){ if(fp[fp2]!==undefined) fp[fp2]+=d.outer[i].flightPaths[fp2]||0; if(fpCounts['outer-'+i][fp2]!==undefined) fpCounts['outer-'+i][fp2]+=d.outer[i].flightPaths[fp2]||0; }); }
      }
    });
  });
  // Round pass — yardageFilter does not apply to round shots
  (rounds||[]).forEach(function(r,idx){
    if(!vizDispSelectedRounds.has(idx)) return;
    (r.holes||[]).forEach(function(h){
      (h.shots||[]).forEach(function(shot){
        if(!shot.radial_ring) return;
        /* SLUG2b -- match shot by clubSlug first, fall back to clubName */
        var shotKey=shot.clubSlug||_lrShotClubName(shot);
        if(shotKey!==key) return;
        totalShots++;
        var ring=shot.radial_ring, seg=shot.radial_segment;
        if(ring==='bull'){ counts.bull++; }
        else if(ring==='inner'&&seg!==null&&seg!==undefined){ counts['inner-'+seg]++; }
        else if(ring==='outer'&&seg!==null&&seg!==undefined){ counts['outer-'+seg]++; }
        var segKey2=ring==='bull'?'bull':((ring==='inner'||ring==='outer')&&seg!==null&&seg!==undefined?(ring+'-'+seg):null);
        if(segKey2&&shot.flight_path&&fpCounts[segKey2]&&fpCounts[segKey2][shot.flight_path]!==undefined) fpCounts[segKey2][shot.flight_path]++;
        var fp2=shot.flight_path;
        if(fp2&&fp[fp2]!==undefined) fp[fp2]++;
      });
    });
  });
  return { counts:counts, fp:fp, totalShots:totalShots, fpCounts:fpCounts };
}

function _buildDispCardInner(key, selectedSessions, yardageFilter){
  /* SLUG2b -- param renamed clubName->key */
  var agg=_aggregateDispCounts(key, selectedSessions, yardageFilter);
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
  var yardageSet={};
  selectedSessions.forEach(function(s){
    var cs=(s.clubSummary||[]).find(function(x){ return (x.clubSlug||x.clubName||x.clubId)===key; });
    if(!cs) return;
    (cs.targets||[]).forEach(function(t){ yardageSet[t.yardage]=true; });
  });
  var yardages=Object.keys(yardageSet).map(Number).sort(function(a,b){ return a-b; });
  var yardageChips='';
  if(yardages.length>1){
    var safeKey=key.replace(/'/g,"\\'");
    var chips=[{val:null,label:'All'}].concat(yardages.map(function(y){ return {val:y,label:y+'y'}; }));
    yardageChips='<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px">'+
      chips.map(function(ch){
        var on=(yardageFilter===null||yardageFilter===undefined)?ch.val===null:ch.val===yardageFilter;
        return '<button onclick="vizDispSetYardage(\''+safeKey+'\','+(ch.val===null?'null':ch.val)+')"'+
          ' style="padding:2px 8px;font-size:.58rem;border-radius:4px;cursor:pointer;'+
          'background:'+(on?'var(--gr3)':'var(--bg)')+';border:1px solid '+(on?'var(--gr2)':'var(--br)')+'">'+
          ch.label+'</button>';
      }).join('')+
    '</div>';
  }
  /* ASKB-4 -- expected overlay gated by askbShow.calc; heat radial gated by rounds||range */
  var expectedOverlay=null;
  if(askbShow.calc){
    var clubObj=bag.find(function(x){return x.slug===key;});
    if(!clubObj){
      // Fallback: name match (legacy entries)
      clubObj=bag.find(function(x){return (x.identifier||x.type)===key;});
    }
    if(clubObj){
      var hcp=(typeof getHandicap==='function'?getHandicap():null)||25;
      var handed=profile.handed||'Right-handed';
      var d2=vizGetDisp(clubObj,hcp,handed,profile.yardType||'Total',vizYardMode);
      if(d2){ expectedOverlay={ rxR:d2.rxR, rxL:d2.rxL, ryU:d2.dl, ryD:d2.ds, tilt:d2.tilt }; }
    }
  }
  var showHeat = !!(askbShow.rounds || askbShow.range);
  return _buildDispRadialSVG(counts,heatMax,agg.fpCounts,expectedOverlay,showHeat)+
    '<div style="font-size:.58rem;color:var(--tx3);margin-top:8px;text-align:center;line-height:1.9">'+statStr+'</div>'+
    yardageChips;
}

export function renderVizDisp(){
  var out=document.getElementById('vizDispOutput');
  if(!out) return;
  var selectedSessions=(rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); });
  var hasAnySource=selectedSessions.length||vizDispSelectedRounds.size;
  if(!hasAnySource){
    out.innerHTML='<div class="card"><div class="hist-empty">No sessions or rounds selected.</div></div>';
    return;
  }
  if(!vizDispSelectedKeys.size){
    out.innerHTML='<div class="card"><div class="hist-empty">No clubs selected.</div></div>';
    return;
  }
  /* SLUG2b -- resolve slug -> display name for sort + render */
  function _nameForKey(key){
    var c=bag.find(function(x){return x.slug===key;});
    if(c) return c.identifier||c.type;
    return key;
  }
  var cards=[];
  var sortedKeys=Array.from(vizDispSelectedKeys).sort(function(a,b){
    var na=_nameForKey(a), nb=_nameForKey(b);
    var ka=_dispClubSortKey(na),kb=_dispClubSortKey(nb);
    return ka!==kb?ka-kb:na.localeCompare(nb);
  });
  sortedKeys.forEach(function(key){
    var yardageFilter=vizDispYardageFilter[key]!==undefined?vizDispYardageFilter[key]:null;
    var totalAll=_aggregateDispCounts(key,selectedSessions,null).totalShots;
    var safeId=key.replace(/[^a-zA-Z0-9]/g,'-');
    var displayName=_nameForKey(key);
    cards.push(
      '<div class="card" style="margin-bottom:10px" id="vdcard-'+safeId+'">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'+
          '<div style="font-family:\'Playfair Display\',serif;font-size:.95rem;color:var(--ac2)">'+escHtml(displayName)+'</div>'+
          '<span style="font-size:.58rem;padding:2px 7px;background:var(--gr3);border:1px solid var(--gr2);border-radius:4px;color:var(--ac)">'+totalAll+' shot'+(totalAll!==1?'s':'')+'</span>'+
        '</div>'+
        '<div id="vdcardinner-'+safeId+'">'+_buildDispCardInner(key,selectedSessions,yardageFilter)+'</div>'+
      '</div>'
    );
  });
  out.innerHTML=cards.length?cards.join(''):'<div class="card"><div class="hist-empty">No matching data for selection.</div></div>';
}

export function vizDispSetYardage(key, yardageFilter){
  /* SLUG2b -- param renamed clubName->key */
  vizDispYardageFilter[key]=yardageFilter===null||yardageFilter==='null'?null:+yardageFilter;
  var selectedSessions=(rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); });
  var safeId=key.replace(/[^a-zA-Z0-9]/g,'-');
  var inner=document.getElementById('vdcardinner-'+safeId);
  if(inner) inner.innerHTML=_buildDispCardInner(key,selectedSessions,vizDispYardageFilter[key]);
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

export function vizDispToggleClub(key){
  /* SLUG2b -- param renamed clubName->key */
  if(vizDispSelectedKeys.has(key)) vizDispSelectedKeys.delete(key);
  else vizDispSelectedKeys.add(key);
  var on=vizDispSelectedKeys.has(key);
  var safeId='vdclub-'+key.replace(/[^a-zA-Z0-9]/g,'-');
  var lbl=document.getElementById(safeId);
  if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  renderVizDisp();
}

export function vizDispToggleRound(idx){
  if(vizDispSelectedRounds.has(idx)) vizDispSelectedRounds.delete(idx);
  else vizDispSelectedRounds.add(idx);
  var on=vizDispSelectedRounds.has(idx);
  var lbl=document.getElementById('vdround-'+idx);
  if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  _buildDispClubShelf();
  renderVizDisp();
}

export function vizDispToggleAllSessions(){
  var committed=(rangeSessions||[]).filter(function(s){ return s.committed; });
  var allSelected=committed.every(function(s){ return vizDispSelectedSessions.has(s.sessionId); });
  if(allSelected){ vizDispSelectedSessions=new Set(); }
  else { vizDispSelectedSessions=new Set(committed.map(function(s){ return s.sessionId; })); }
  committed.forEach(function(s){
    var on=vizDispSelectedSessions.has(s.sessionId);
    var lbl=document.getElementById('vdsess-'+s.sessionId);
    if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  });
  var btn=document.getElementById('vizDispSessionAllBtn');
  if(btn) btn.textContent=vizDispSelectedSessions.size===0?'All':'None';
  _buildDispClubShelf();
  renderVizDisp();
}

export function vizDispToggleAllRounds(){
  var eligible=(rounds||[]).map(function(r,i){ return i; }).filter(function(i){
    var r=rounds[i];
    return r&&(r.holes||[]).some(function(h){
      return (h.shots||[]).some(function(s){ return s&&s.radial_ring; });
    });
  });
  var allSelected=eligible.every(function(i){ return vizDispSelectedRounds.has(i); });
  if(allSelected){ vizDispSelectedRounds=new Set(); }
  else { vizDispSelectedRounds=new Set(eligible); }
  eligible.forEach(function(i){
    var on=vizDispSelectedRounds.has(i);
    var lbl=document.getElementById('vdround-'+i);
    if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  });
  var btn=document.getElementById('vizDispRoundAllBtn');
  if(btn) btn.textContent=vizDispSelectedRounds.size===0?'All':'None';
  _buildDispClubShelf();
  renderVizDisp();
}

/* UI-γ2 — bulk select/deselect for club shelf; mirrors vizDispToggleAllSessions pattern */
export function vizDispToggleAllClubs(){
  var keys=Object.keys((function(){
    var map={};
    (rangeSessions||[]).filter(function(s){ return s.committed&&vizDispSelectedSessions.has(s.sessionId); }).forEach(function(s){
      (s.clubSummary||[]).forEach(function(cs){
        var key=cs.clubSlug||cs.clubName||cs.clubId; if(key) map[key]=1;
      });
    });
    (rounds||[]).forEach(function(r,idx){
      if(!vizDispSelectedRounds.has(idx)) return;
      (r.holes||[]).forEach(function(h){
        (h.shots||[]).forEach(function(shot){
          if(!shot.radial_ring) return;
          var key=shot.clubSlug||(shot.clubName)||''; if(key) map[key]=1;
        });
      });
    });
    return map;
  })());
  var allSelected=keys.length>0&&keys.every(function(k){ return vizDispSelectedKeys.has(k); });
  if(allSelected){ vizDispSelectedKeys=new Set(); }
  else { vizDispSelectedKeys=new Set(keys); }
  keys.forEach(function(key){
    var on=vizDispSelectedKeys.has(key);
    var safeId='vdclub-'+key.replace(/[^a-zA-Z0-9]/g,'-');
    var lbl=document.getElementById(safeId);
    if(lbl){ lbl.style.background=on?'var(--gr3)':'var(--bg)'; lbl.style.borderColor=on?'var(--gr2)':'var(--br)'; }
  });
  var btn=document.getElementById('vizDispClubAllBtn');
  if(btn) btn.textContent=vizDispSelectedKeys.size===0?'All':'None';
  renderVizDisp();
}

/* ASKB-4 -- per-toggle handler. key in {calc, rounds, range}. Re-renders active viz mode. */
export function askbSetToggle(key) {
  if (key !== 'calc' && key !== 'rounds' && key !== 'range') return;
  askbShow[key] = !askbShow[key];
  try { localStorage.setItem('vc:askb:show', JSON.stringify(askbShow)); } catch(e) {}
  askbSyncButtons();
  if (vizMode === 'dispersion') renderVizDisp();
  else renderViz();
}

/* ASKB-4 -- reflect state on all button mounts (dispersion panel + shared controls). */
export function askbSyncButtons() {
  ['calc','rounds','range'].forEach(function(k){
    var on = !!askbShow[k];
    ['askbT-'+k, 'askbT2-'+k].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.classList.toggle('on', on);
    });
  });
}

/* ASKB-3 -- observed overlay renderer (heatmap markers).
   Centre is always the straight-shot target (caller passes cx,cy unbiased).
   refR is a simple size (no tilt, no asymmetry) -- observed drift vs expected is the point.
   Renders 3 concentric rings + 8 segment wedges, heat-coloured by count.
   Labels (%, flight-path arrows) scaled to refR, hidden below readable threshold.
   obs = { bucketCounts, sampleSize, fpCounts } from aggregateObservedDispersion. */
export function vizRenderObservedMarker(cx, cy, refR, obs, strokeHex) {
  if (!obs || !obs.bucketCounts) return '';
  var d = obs.bucketCounts;
  var rB = refR * 0.25, rI = refR * 0.60, rO = refR * 1.00;
  var innerTot = 0, outerTot = 0, i;
  for (i = 0; i < 8; i++) { innerTot += d.inner[i]; outerTot += d.outer[i]; }
  var total = d.bull + innerTot + outerTot;
  if (!total) return '';
  var heatMax = Math.max(d.bull, 1);
  for (i = 0; i < 8; i++) {
    if (d.inner[i] > heatMax) heatMax = d.inner[i];
    if (d.outer[i] > heatMax) heatMax = d.outer[i];
  }
  var heatR = function(n) {
    if (!n) return 'rgba(255,255,255,0)';
    return 'rgba(160,30,30,' + (0.18 + (n / heatMax) * 0.72).toFixed(2) + ')'; /* ASKB-FIX -- alpha range matched to dispersion tab _buildDispRadialSVG (was 0.20+0.55) */
  };
  var arc = function(r1, r2, startDeg, endDeg) {
    var rad = function(a){ return a * Math.PI / 180; }; /* ASKB-FIX -- segment rotation matched to dispersion tab (was a-90, caused 90deg CCW offset) */
    var pt = function(r, a){ return [(cx + r*Math.sin(rad(a))).toFixed(2), (cy - r*Math.cos(rad(a))).toFixed(2)]; };
    var s1 = pt(r2, startDeg), e1 = pt(r2, endDeg);
    var s2 = pt(r1, endDeg),   e2 = pt(r1, startDeg);
    return 'M ' + s1[0] + ' ' + s1[1] + ' A ' + r2 + ' ' + r2 + ' 0 0 1 ' + e1[0] + ' ' + e1[1] +
           ' L ' + s2[0] + ' ' + s2[1] + ' A ' + r1 + ' ' + r1 + ' 0 0 0 ' + e2[0] + ' ' + e2[1] + ' Z';
  };
  var paths = '';
  for (i = 0; i < 8; i++) paths += '<path d="' + arc(rB, rI, (i*45)-22.5, (i*45)+22.5) + '" fill="' + heatR(d.inner[i]) + '"/>';
  for (i = 0; i < 8; i++) paths += '<path d="' + arc(rI, rO, (i*45)-22.5, (i*45)+22.5) + '" fill="' + heatR(d.outer[i]) + '"/>';
  paths += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + rB.toFixed(2) + '" fill="' + heatR(d.bull) + '"/>';
  var stroke = strokeHex || 'rgba(255,255,255,0.55)';
  paths += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + rB.toFixed(2) + '" fill="none" stroke="' + stroke + '" stroke-width="1" stroke-dasharray="2 2" opacity="0.7"/>';
  paths += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + rI.toFixed(2) + '" fill="none" stroke="' + stroke + '" stroke-width="1" stroke-dasharray="2 2" opacity="0.55"/>';
  paths += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + rO.toFixed(2) + '" fill="none" stroke="' + stroke + '" stroke-width="1.2" stroke-dasharray="3 2" opacity="0.75"/>';

  /* ASKB-3 -- % + flight-path labels, scaled to refR. Mirrors dispersion-tab _buildDispRadialSVG labelling.
     Font scales refR/15 (dispersion tab uses 9pt at 300x300 -> refR~135). Hide labels below 4pt. */
  var fs = Math.max(3, Math.min(9, refR / 15));
  var fc = obs.fpCounts || null;
  if (fs >= 4) {
    var fsStr = fs.toFixed(1), fsSmall = (fs * 0.8).toFixed(1);
    var pctLbl = function(pct, x, y) {
      return pct > 0 ? '<text x="' + x + '" y="' + y + '" font-family="monospace" font-size="' + fsStr + '" fill="white" text-anchor="middle">' + pct + '%</text>' : '';
    };
    var fpLine = function(segKey, segCount, x, y) {
      if (!fc || !segCount) return '';
      var sfp = fc[segKey]; if (!sfp) return '';
      var parts = [];
      if (sfp.straight > 0)         parts.push('\u2191' + Math.round(sfp.straight / segCount * 100) + '%');
      if (sfp['left-to-right'] > 0) parts.push('\u21b1' + Math.round(sfp['left-to-right'] / segCount * 100) + '%');
      if (sfp['right-to-left'] > 0) parts.push('\u21b0' + Math.round(sfp['right-to-left'] / segCount * 100) + '%');
      if (!parts.length) return '';
      return '<text x="' + x + '" y="' + (parseFloat(y) + fs * 1.1).toFixed(2) + '" font-family="monospace" font-size="' + fsSmall + '" fill="white" text-anchor="middle">' + parts.join(' ') + '</text>';
    };
    paths += pctLbl(Math.round((d.bull || 0) / total * 100), cx.toFixed(2), (cy + fs * 0.4).toFixed(2));
    var iMid = (rB + rI) / 2, oMid = (rI + rO) / 2;
    for (i = 0; i < 8; i++) {
      var ang = i * 45 * Math.PI / 180;
      var ix = (cx + iMid * Math.sin(ang)).toFixed(2), iy = (cy - iMid * Math.cos(ang) + fs * 0.3).toFixed(2);
      var ox = (cx + oMid * Math.sin(ang)).toFixed(2), oy = (cy - oMid * Math.cos(ang) + fs * 0.3).toFixed(2);
      paths += pctLbl(Math.round((d.inner[i] || 0) / total * 100), ix, iy);
      paths += fpLine('inner-' + i, d.inner[i] || 0, ix, iy);
      paths += pctLbl(Math.round((d.outer[i] || 0) / total * 100), ox, oy);
      paths += fpLine('outer-' + i, d.outer[i] || 0, ox, oy);
    }
  }
  paths += '<text x="' + cx.toFixed(2) + '" y="' + (cy - rO - 3).toFixed(2) + '" font-family="monospace" font-size="7" fill="' + stroke + '" text-anchor="middle" opacity="0.85">n=' + obs.sampleSize + '</text>';
  return '<g class="askb-obs">' + paths + '</g>';
}

/* ASKB-3 helper -- resolve observed aggregate for a club using askbShow.rounds/range.
   Slug-only per SLUG1 contract. Returns null if both sources off, no slug, or <5 shots. */
export function askbGetObserved(club) {
  if (!club) return null;
  if (!askbShow.rounds && !askbShow.range) return null;
  if (!club.slug) return null;
  var src = (askbShow.rounds && askbShow.range) ? 'both' : (askbShow.rounds ? 'rounds' : 'range');
  return aggregateObservedDispersion(club.slug, {
    source: src,
    minShots: 5,
    rangeSessions: rangeSessions || [],
    rounds: rounds || []
  });
}

Object.assign(window, {
  onVizModeChange, onVizClubSrcChange, onVizOptSessionChange,
  onVizCourseChange, onVizTeeChange, onVizHoleSessionChange,
  resetVizMaxRange, saveManualBag, saveManualPlan,
  setVizDisplay, setVizYard, vizSelectHole,
  vizToggleClub, vizTogglePath, vizTogglePlanner, vizUpdatePath,
  vizDispToggleSession, vizDispToggleClub, vizDispSetYardage, vizDispToggleRound,
  vizDispToggleAllSessions, vizDispToggleAllRounds,
  vizDispToggleAllClubs, /* UI-γ3 */
  askbSetToggle,         /* ASKB-4 */
  askbSyncButtons,       /* ASKB-4 */
  /* VIZMAP-2 -- map mode handlers */
  _vizMapLoadClick: _vizMapLoad,
  _vizMapSetStyle: function(m){
    vizMapState.styleMode = m;
    try { localStorage.setItem('vc:viz:mapStyle', m); } catch(e) {}
    if (vizMapState.mapInstance) vizMapState.mapInstance.setStyleMode(m);
    _vizMapRenderPanel();
  },
  _vizMapSetAskb: function(m){
    vizMapState.askbMode = m;
    try { localStorage.setItem('vc:viz:askbMode', m); } catch(e) {}
    _vizMapRenderAskb();
    _vizMapRenderPanel();
  },
  _vizMapSetActivePath: function(i){
    vizMapState.activePath = i;
    vizMapState.pendingClubs[i] = null; /* clear pending on path switch */
    if (vizMapState.mapInstance) vizMapState.mapInstance.setActivePathIdx(i);
    _vizMapRenderPanel();
  },
  _vizMapTogglePathVis: function(i){ vizTogglePath(i); },
  _vizMapPickClubForActivePath: function(clubId){
    if (!clubId) return;
    vizMapState.pendingClubs[vizMapState.activePath] = clubId;
    _vizMapToast('Tap the map to place target');
    _vizMapRenderChainPanel();
  },
  _vizMapRemoveShot: function(pathIdx, shotIdx){
    if (vizMapState.mapInstance) vizMapState.mapInstance.removeWaypoint(pathIdx, shotIdx);
    vizPaths[pathIdx].splice(shotIdx, 1);
    if (vizHoleEdits[vizSelectedHole] && vizHoleEdits[vizSelectedHole].waypoints) {
      vizHoleEdits[vizSelectedHole].waypoints[pathIdx].splice(shotIdx, 1);
    }
    vizMapState._lastWaypointCounts = [
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(0).length : 0,
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(1).length : 0,
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(2).length : 0
    ];
    _vizPlaceWaypointMarkers();
    _vizMapRenderAskb();
    _vizMapRenderChainPanel();
  },
  _vizMapClearActivePath: function(){
    var p = vizMapState.activePath;
    if (vizMapState.mapInstance) vizMapState.mapInstance.clearWaypoints(p);
    vizPaths[p] = [];
    if (vizHoleEdits[vizSelectedHole] && vizHoleEdits[vizSelectedHole].waypoints) {
      vizHoleEdits[vizSelectedHole].waypoints[p] = [];
    }
    vizMapState._lastWaypointCounts = [
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(0).length : 0,
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(1).length : 0,
      vizMapState.mapInstance ? vizMapState.mapInstance.getWaypoints(2).length : 0
    ];
    _vizPlaceWaypointMarkers();
    _vizMapRenderAskb();
    _vizMapRenderChainPanel();
  },
  _vizSetHoleViewMode: function(m){
    if (m !== 'synthetic' && m !== 'map') return;
    vizHoleViewMode = m;
    try { localStorage.setItem('vc:viz:holeView', m); } catch(e) {}
    if (m === 'synthetic') {
      _vizMapUnmount();
      /* Show SVG card, hide map panel */
      var card = document.getElementById('vizSvgCard');
      if (card) card.style.display = 'block';
      var panel = document.getElementById('vizMapPanel');
      if (panel) panel.style.display = 'none';
    }
    renderViz();
  }
});
