// src/caddie.js
// AI caddie session, export/import, and text processing.
// Depends on: geo.js, store.js, dispersion.js, clubs.js

import { fmtDate, deriveStats, calcImplied, calcPlayHcp, tierIndex, calcDiff, aggregateObservedDispersion } from './geo.js'; /* ASKB-5 */
import { uid, today, save, bag, courses, rounds, history, profile, removeHistory, rangeSessions, removeRangeSession } from './store.js';
import { getDispersion } from './dispersion.js';
import { getYardLabel } from './clubs.js';

// -- Skill / task text helpers ------------------------------------------------
function getSkillText() {
  return localStorage.getItem('vc:skill') ||
    '[Skill unavailable \u2014 cache empty and Gist unreachable. Upload skill.md alongside this export file in your AI chat.]';
}
function getRefText() {
  return localStorage.getItem('vc:ref') ||
    '[Reference data unavailable \u2014 cache empty and Gist unreachable. Upload reference-data.md alongside this export file in your AI chat.]';
}
function getClubTaskText() {
  return localStorage.getItem('vc:clubTask') || `ClubTaskVersion: 1
# Virtual Caddie \u2014 Club Setup Task (bundled fallback)
Ask the user to list their clubs. Derive type/loft/shaft/stiffness from standard defaults. Use Y2 yardage ranges (HCP 15-19) unless user gives distances. Confirm full set in one block before writing. One club set per chat.
Y2 defaults: Driver 200-230 | 3W 175-200 | 5W 160-185 | 7W 150-170 | 3H 165-185 | 4H 155-175 | 5H 145-165 | 6H 135-155 | 7H 125-145 | 8H 115-135 | 9H 105-125 | 7i 125-145 | 8i 115-135 | 9i 105-125 | PW 95-115 | GW52 80-100 | SW56 60-80 | LW60 45-65
Output: standard session result, Type: data-update, DATA CHANGES with CLUB and SESSION lines. Putter uses PUTTER, no SESSION line. Confidence 3, Bias Straight.`;
}
function getCourseTaskText() {
  return localStorage.getItem('vc:courseTask') || `CourseTaskVersion: 1
# Virtual Caddie \u2014 Course Lookup Task (bundled fallback)
Ask the user for the course name and region. Search: official site \u2192 golf association \u2192 18Birdies (last resort, state source). Show tees found, ask which to save. Collect par/yards/stroke-index for all 18 holes per tee. Confirm before writing. One course per chat.
Output: standard session result, Type: data-update, DATA CHANGES with COURSE / TEE / HOLE lines. IDs: c-[6chars] for course, t-[6chars] for tee. Leave yards blank (not zero) if unknown.`;
}
function getSetupSkillText() {
  return localStorage.getItem('vc:setupSkill') || `SetupSkillVersion: 1
# Virtual Caddie \u2014 First-Time Setup (bundled fallback)
Read the uploaded file. Note what profile/clubs/courses are already present. Skip steps already done.
Step 1 \u2014 Profile: ask name, handed, yardpref, handicap (optional) together in one message.
Step 2 \u2014 Clubs: ask for free-text club list. Derive full set using Y2 defaults (HCP 15-19). Confirm in one block before writing. Confidence 3, Bias Straight.
Step 3 \u2014 Course: ask course name, web search for scorecard, confirm tees, confirm hole data before writing. One course per chat.
Step 4 \u2014 Offer optimization now or skip.
Output: session result Type data-update or both. DATA CHANGES includes PROFILE fields collected, CLUB+SESSION lines, COURSE+TEE+HOLE lines.
Resource rule: one course, one optimization per chat.`;
}
function getRoundTaskText() {
  return localStorage.getItem('vc:roundTask') || `RoundTaskVersion: 1
# Virtual Caddie \u2014 Round Logging Task (bundled fallback)
Help the user log one or more rounds of golf. Accept any input format: verbal scores, typed hole-by-hole, or a scorecard image/photo.
Ask if anything is ambiguous: date, tee colour, course name. One clarifying question at a time.
For each round collect: date, course name, tee, course rating, slope, par, gross score, and optionally hole-by-hole (par, score, putts, GIR Y/N, notes).
Output: session result, Type: data-update. DATA CHANGES section contains one ROUND line per round, followed by indented SESSIONIDS and HOLE lines if detail was provided.
Format:
ROUND | YYYY-MM-DD | Course Name | Tee | Rating | Slope | Par | Score | Diff | Notes
  SESSIONIDS | id1,id2
  HOLE | 1 | par | score | putts | gir | notes
  HOLE | 2 | par | score | putts | gir | notes
Diff = round((Score - Rating) * 113 / Slope, 1). Leave blank if rating/slope unknown.
GIR: Y if green reached in (par minus 2) strokes or fewer, N otherwise. Leave blank if unknown.
SESSIONIDS: only include if user specifies which caddie plan they used \u2014 leave line out entirely if not mentioned.
AI-agnostic: plain language only, no platform-specific features.`;
}

// -- Sessions -----------------------------------------------------------------
function updateCourseSelects() {
  updateCourseDropdowns();
  /* CF2 -- show/hide no-course message in Viz tab */
  const ncm = document.getElementById('vizNoCourseMsg');
  if(ncm) ncm.style.display = courses.length ? 'none' : 'block';
}

function updateCadTees() {
  const courseId = document.getElementById('cadCourse')?.value;
  const sel = document.getElementById('cadTee');
  if(!sel) return;
  const course = courses.find(c => c.id === courseId);
  if(!course || !course.tees || !course.tees.length) { sel.innerHTML = '<option value="">\u2014 no tees \u2014</option>'; return; }
  sel.innerHTML = course.tees.map(t =>
    `<option value="${t.id}">${t.name} \u2014 ${t.yardage ? (+t.yardage).toLocaleString() : '?'} yds (${t.rating}/${t.slope})</option>`
  ).join('');
  if(course.selectedTee) sel.value = course.selectedTee;
}

function renderAIHelp() {
  // Populate caddie course select + restore opt tier
  const cs = document.getElementById('cadCourse');
  if(cs) {
    const prev = cs.value;
    cs.innerHTML = courses.length
      ? courses.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')
      : '<option value="">\u2014 no courses saved \u2014</option>';
    if(prev && courses.find(c=>c.id===prev)) cs.value = prev;
    else if(profile.homeCourseId && courses.find(c=>c.id===profile.homeCourseId)) cs.value = profile.homeCourseId;
    updateCadTees();
  }
  const ot = document.getElementById('cadOptTier');
  if(ot) { const saved = localStorage.getItem('vc:optTier'); if(saved) ot.value = saved; }
}

function renderSessions() {
  const badge = document.getElementById('sessionsBadge');
  const caddieSessions = history.filter(h=>h.type!=='data-update');
  const allCount = caddieSessions.length + rangeSessions.length;
  if(badge) badge.textContent = allCount;
  const el = document.getElementById('sessionsList');
  if(!el) return;
  if(!caddieSessions.length) {
    el.innerHTML = '<div class="hist-empty">No caddie sessions yet. Go to the GORDy tab to run your first session.</div>';
  } else {
    el.innerHTML = caddieSessions.slice().sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(h => {
      const d = fmtDate(h.date);
      const typeLabel = h.type==='optimisation' ? '\uD83E\uDD16 Bag Optimisation' : h.type==='caddie' ? '\uD83E\uDD16 Hole-by-Hole Caddie' : h.type==='both' ? '\uD83E\uDD16 Full Caddie Session' : h.type==='manual' ? '\u270F\uFE0F Manual Plan' : '\uD83D\uDCCB Session';
      const meta = [h.tee?h.tee+' tees':'',h.holes&&h.holes!=='all 18'?h.holes:'',h.hcp&&h.hcp!=='not set'?'HCP '+h.hcp:'',h.conditions&&h.conditions!=='calm'?h.conditions:''].filter(Boolean).join(' \u00B7 ');
      return `
    <div class="hist-item" id="si-${h.id}" onclick="toggleSession('${h.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ac);margin-bottom:2px;">${typeLabel}</div>
          <div class="hist-course">${h.course||'Unnamed'}${h.tee?' \u2014 '+h.tee+' tees':''}</div>
          <div style="font-size:.62rem;color:var(--tx3);margin-top:2px;">${meta}</div>
          <div class="hist-preview" style="margin-top:4px;">${escHtml(h.text)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <div style="font-size:.6rem;color:var(--tx3);white-space:nowrap;">${d}</div>
          <button class="btn sec" style="font-size:.55rem;padding:2px 7px" onclick="event.stopPropagation();exportSessionPdf('${h.id}')">&#128196; Scorecard</button>
          <button style="background:var(--danger);color:white;border:1px solid var(--danger);border-radius:4px;cursor:pointer;font-size:1rem;padding:4px 8px;line-height:1" onclick="event.stopPropagation();confirmDeleteCaddieSession('${h.id}')">\u2715</button>
        </div>
      </div>
      <div class="hist-body">${escHtml(h.text)}</div>
    </div>`;
    }).join('');
  }
  if (window.renderRangeSessions) window.renderRangeSessions();
}

function toggleSession(id) { document.getElementById('si-' + id)?.classList.toggle('open'); }
function toggleRangeSession(id) { document.getElementById('rsi-' + id)?.classList.toggle('open'); }

function deleteCaddieSession(id) {
  removeHistory(id);
  save(); renderSessions();
}

function deleteRangeSession(id) {
  removeRangeSession(id);
  save(); renderSessions();
}

// Inline confirm before delete — injects strip into row, no modal
function confirmDeleteRangeSession(id) {
  if (document.getElementById('rsi-confirm-' + id)) return;
  var row = document.getElementById('rsi-' + id);
  if (!row) return;
  var strip = document.createElement('div');
  strip.id = 'rsi-confirm-' + id;
  strip.style.cssText = 'padding:6px 10px;font-size:.65rem;display:flex;gap:8px;align-items:center;border-top:1px solid var(--br);flex-wrap:wrap';
  strip.innerHTML = '<span style="color:var(--danger)">Delete this session?</span>' +
    '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);font-size:.6rem;padding:2px 8px" onclick="deleteRangeSession(\'' + id + '\')">Delete</button>' +
    '<button class="btn sec" style="font-size:.6rem;padding:2px 8px" onclick="document.getElementById(\'rsi-confirm-' + id + '\').remove()">Cancel</button>';
  row.appendChild(strip);
}

function confirmDeleteCaddieSession(id) {
  if (document.getElementById('si-confirm-' + id)) return;
  var row = document.getElementById('si-' + id);
  if (!row) return;
  var strip = document.createElement('div');
  strip.id = 'si-confirm-' + id;
  strip.style.cssText = 'padding:6px 10px;font-size:.65rem;display:flex;gap:8px;align-items:center;border-top:1px solid var(--br);flex-wrap:wrap';
  strip.innerHTML = '<span style="color:var(--danger)">Delete this session?</span>' +
    '<button class="btn" style="background:var(--danger);color:white;border-color:var(--danger);font-size:.6rem;padding:2px 8px" onclick="deleteCaddieSession(\'' + id + '\')">Delete</button>' +
    '<button class="btn sec" style="font-size:.6rem;padding:2px 8px" onclick="document.getElementById(\'si-confirm-' + id + '\').remove()">Cancel</button>';
  row.appendChild(strip);
}

// Keep renderHistory as alias so import logic still works
function renderHistory() { renderSessions(); }

// -- Export for AI ------------------------------------------------------------
function exportForAI() {
  const st = document.getElementById('cadStatus');
  const eligibleClubs = bag.filter(c=>c.tested===true&&(c.sessions||[]).length>0);
  const courseId = document.getElementById('cadCourse')?.value;

  // Gate 1 -- clubs
  if(!eligibleClubs.length) {
    if(st) st.innerHTML = '\u26A0 No active clubs with sessions. <a href="#" style="color:var(--ac)" onclick="showTab(\'clubs\');return false">Add clubs</a> or use \uD83E\uDD16 Get AI Help on the GORDy tab.';
    return;
  }
  // Gate 2 -- course
  if(!courseId) {
    if(st) st.innerHTML = '\u26A0 No course selected. <a href="#" style="color:var(--ac)" onclick="showTab(\'courses\');return false">Add a course</a> or use \uD83E\uDD16 Get AI Help on the GORDy tab.';
    return;
  }

  const teeId   = document.getElementById('cadTee')?.value;
  const type    = document.getElementById('cadType')?.value || 'both';
  const holes   = document.getElementById('cadHoles')?.value || 'all 18';
  const conds   = document.getElementById('cadConditions')?.value || 'calm';
  const optTier = document.getElementById('cadOptTier')?.value || localStorage.getItem('vc:optTier') || '4';

  const course = courses.find(c=>c.id===courseId);
  const tee    = course?.tees?.find(t=>t.id===teeId);

  // Gate 3 -- hole yardage completeness (warn, don't block)
  const wantsHoleByHole = (type==='caddie'||type==='both');
  if(wantsHoleByHole && tee) {
    const holeYards = (tee.holes||[]).filter(h=>h.yards&&+h.yards>0).length;
    const total = (tee.holes||[]).length;
    if(total===0 || holeYards===0) {
      if(st) st.innerHTML = '\u26A0 No hole yardages for this tee \u2014 hole-by-hole advice unavailable. Switching to bag optimisation only, or <a href="#" style="color:var(--ac)" onclick="showTab(\'courses\');return false">add hole data</a>.';
      // Override type to optimisation only -- don't block, just downgrade
      document.getElementById('cadType').value = 'optimisation';
    } else if(holeYards < total) {
      if(st) st.textContent = '\u26A0 ' + (total-holeYards) + ' hole(s) missing yardage \u2014 those holes will show CANNOT ADVISE in the caddie output.';
      // Proceed -- partial data is allowed
    }
  }

  const hcpIdx  = getHandicap();
  const playHcp = (course && tee && hcpIdx !== null)
    ? calcPlayHcp(hcpIdx, +tee.slope, +tee.rating, +course.par)
    : null;

  const skillText = getSkillText();
  const refText   = getRefText();
  const skillVer  = (skillText.match(/SkillVersion:\s*(\d+)/)||[])[1] || '?';
  const refVer    = (refText.match(/ReferenceVersion:\s*(\d+)/)||[])[1] || '?';

  const L = [
    '=== VIRTUAL CADDIE EXPORT ===',
    'ExportVersion: 1',
    `SkillVersion: ${skillVer}`,
    `ReferenceVersion: ${refVer}`,
    `ExportDate: ${today()}`,
    '',
    '=== INSTRUCTIONS ===',
    skillText,
    '',
    '=== REFERENCE ===',
    refText,
    '',
    '=== DATA ===',
    '',
    '--- PROFILE ---',
  ];

  /* 1A -- PROFILE: tier-gated fields */
  const p = profile;
  if(p.name)   L.push(`NAME | ${p.name}`);
  if(+optTier >= 4 && p.age)      L.push(`AGE | ${p.age}`);
  if(+optTier >= 2 && p.gender)   L.push(`GENDER | ${p.gender}`);
  if(p.handed) L.push(`HANDED | ${p.handed}`);
  if(+optTier >= 4 && p.homeClub) L.push(`HOMECLUB | ${p.homeClub}`);
  if(p.yardType) L.push(`YARDPREF | ${p.yardType}`);
  if(+optTier >= 4 && p.notes) p.notes.split('\n').forEach(function(nl){ if(nl.trim()) L.push('NOTE | '+nl); });

  /* 1A -- CLUBS: tier-gated emission */
  L.push('', '--- CLUBS ---');
  let activeCnt = 0;
  const ti = tierIndex(hcpIdx);
  bag.forEach(c => {
    const cst = c.tested === 'PUTTER' ? 'PUTTER' : (c.tested ? 'YES' : 'NO');
    if(+optTier === 1) {
      /* T1: identifier in field 3, all other fields blank; suppress SESSION lines */
      L.push(`CLUB | | | ${c.identifier||''} | | | | | | | |`);
    } else {
      /* T2+: full CLUB line + SESSION lines */
      L.push(`CLUB | ${c.brand||''} | ${c.type} | ${c.identifier||''} | ${c.stiffness||''} | ${c.shaftLength||''} | ${cst} | ${c.confidence||4} | ${c.bias||'Straight'} | ${c.yardType||''} | ${c.loft||''} | ${c.model||''}`);
      (c.sessions||[]).forEach(s => L.push(`  SESSION | ${s.date} | ${s.min} | ${s.max}`));
    }
    if(c.tested === true && c.sessions?.length) {
      activeCnt++;
      const stats = deriveStats(c.sessions);
      const imp   = stats ? calcImplied(stats, c) : null;
      const disp  = getDispersion(c, getHandicap());
      if(stats) {
        const impMin = imp ? imp.impMin : stats.avgMin;
        const impMax = imp ? imp.impMax : stats.avgMax;
        const midpoint = Math.round((impMin + impMax) / 2);
        if(+optTier === 1) {
          L.push(`  COMPUTED | Midpoint=${midpoint} | YardType=${getYardLabel(c)}`);
        } else {
          L.push(`  COMPUTED | AvgMin=${stats.avgMin} | AvgMax=${stats.avgMax} | ImpMin=${impMin} | ImpMax=${impMax} | Midpoint=${midpoint} | DispRadius=${disp?disp.latHalf:'?'} | LongShort=${disp?disp.depShort:'?'}/${disp?disp.depLong:'?'} | YardType=${getYardLabel(c)}`);
        }
      }
    }
  });

  /* ASKB-5 -- OBSERVED DISPERSION section (Tier 3+ only).
     Source=both: export is data-complete regardless of viz toggle; AI gets fullest picture.
     One line per eligible club (sampleSize >= 5). Uses identifier (not slug) for AI contract consistency. */
  if (+optTier >= 3) {
    const observedLines = [];
    bag.forEach(function(c){
      if (c.tested !== true || !c.slug) return;
      const obs = aggregateObservedDispersion(c.slug, {
        source: 'both',
        minShots: 5,
        rangeSessions: rangeSessions || [],
        rounds: rounds || [],
        bag: bag
      });
      if (!obs) return;
      const fm = obs.flightPathMix;
      observedLines.push('OBSERVED | ' + c.identifier + ' | n=' + obs.sampleSize +
        ' | miss=' + obs.missDirection +
        ' | str=' + fm.str + '%,ltr=' + fm.ltr + '%,rtl=' + fm.rtl + '%' +
        ' | tag=' + obs.shotTag);
    });
    if (observedLines.length) {
      L.push('', '--- OBSERVED DISPERSION ---');
      observedLines.forEach(function(ln){ L.push(ln); });
    }
  }

  /* 1A -- COURSES: selected tee only, hole detail tier-gated */
  L.push('', '--- COURSES ---');
  if(course) {
    const sc = _stripGeometry(course); // geometry must never be sent to AI
    L.push(`COURSE | ${sc.id} | ${sc.name} | ${sc.city||''} | ${sc.par||''} | ${sc.rating||''} | ${sc.slope||''} | ${sc.yardage||''} | ${sc.selectedTee||''} | ${sc.updatedAt||''}`);
    /* Emit selected tee only */
    const selTee = (sc.tees||[]).find(t => t.id === teeId) || (sc.tees||[])[0];
    if(selTee) {
      L.push(`  TEE | ${selTee.id} | ${selTee.name} | ${selTee.rating||''} | ${selTee.slope||''} | ${selTee.yardage||''}`);
      (selTee.holes||[]).forEach(h => {
        if(+optTier === 1) {
          L.push(`    HOLE | ${h.number} | | ${h.yards||''} | |`);
        } else if(+optTier === 2) {
          L.push(`    HOLE | ${h.number} | ${h.par||''} | ${h.yards||''} | ${h.handicap||''} |`);
        } else {
          L.push(`    HOLE | ${h.number} | ${h.par||''} | ${h.yards||''} | ${h.handicap||''} | ${h.note||''}`);
          if (h.geoSummary) L.push(`    ${h.geoSummary}`); /* GEO-SUM: emit at tier 3+4 only */
        }
      });
    }
  } else {
    L.push('# No course selected');
  }

  /* 1A -- HANDICAP: tier-gated fields */
  L.push('', '--- HANDICAP ---');
  const hcpMode   = localStorage.getItem('vc:hcpMode')||'calculated';
  const manualHcp = localStorage.getItem('vc:manualHcp')||'';
  if(+optTier >= 4) L.push(`MODE | ${hcpMode}`);
  if(+optTier >= 4 && manualHcp) L.push(`MANUAL | ${manualHcp}`);
  L.push(`ACTIVE | ${hcpIdx !== null ? hcpIdx : 'not set'}`);
  if(+optTier >= 2) L.push(`PLAYING_HCP | ${playHcp !== null ? playHcp : 'not computed \u2014 select course and tee'}`);

  /* SESSION PARAMETERS: unchanged */
  L.push('', '--- SESSION PARAMETERS ---');
  L.push(`TYPE | ${type}`);
  L.push(`COURSE | ${course ? course.name : 'not selected'}`);
  L.push(`TEE | ${tee ? tee.name : 'not selected'}`);
  L.push(`HOLES | ${holes}`);
  L.push(`CONDITIONS | ${conds}`);
  L.push(`OPT_TIER | ${optTier}`);

  /* 1A -- COMPUTED SUMMARY: dropped at all tiers (redundant) */
  /* was: HCP_INDEX | PLAYING_HCP | ACTIVE_CLUBS -- removed */

  /* 1A -- ROUND CONTEXT: Tier 3+ only */
  if(+optTier >= 3) {
    // Round context -- smart 6-slot algorithm:
    // From last 10 rounds: up to 6 most recent at this course, fill remainder with most recent other rounds
    L.push('', '--- ROUND CONTEXT ---');
    L.push('# Pre-filtered round history for this session. No further filtering needed.');
    L.push(`# Course: ${course ? course.name : 'none selected'} \u00B7 Up to 6 slots: course rounds prioritised, filled with recent rounds.`);
    if(rounds.length) {
      const last10 = [...rounds].slice(0,10); // already sorted newest first
      const courseName = course?.name||'';
      const courseMatches = last10.filter(r=>{
        if(!courseName) return false;
        const cn = (r.courseName||'').toLowerCase();
        const sel = courseName.toLowerCase();
        return cn === sel || cn.includes(sel.split(' ')[0]) || sel.includes(cn.split(' ')[0]);
      });
      const others = last10.filter(r=>!courseMatches.includes(r));
      const slots = [...courseMatches.slice(0,6), ...others].slice(0,6);
      if(slots.length) {
        slots.forEach(r=>{
          const atCourse = courseMatches.includes(r);
          L.push(`ROUND | ${r.date} | ${r.courseName||''} | ${r.tee||''} | ${r.rating||''} | ${r.slope||''} | ${r.par||''} | ${r.score||''} | ${r.diff!==null?r.diff:''} | ${r.notes||''}${atCourse?' # this course':''}`);
        });
      } else {
        L.push('# No rounds logged yet.');
      }
    } else {
      L.push('# No rounds logged yet.');
    }
  }

  /* 1A -- HISTORY block: Tier 4 only.
     Last 6 rounds at selected courseId; if fewer than 6, pad with most recent other rounds. */
  if(+optTier >= 4 && rounds.length) {
    const courseRounds = rounds.filter(r => r.courseId && courseId && r.courseId === courseId);
    const otherRounds  = rounds.filter(r => !(r.courseId && courseId && r.courseId === courseId));
    const histSlots    = [...courseRounds.slice(0,6), ...otherRounds].slice(0,6);
    if(histSlots.length) {
      L.push('', '--- HISTORY ---');
      histSlots.forEach(r => {
        L.push(`HISTORY-ROUND | ${r.date} | ${r.courseName||''} | ${r.tee||''} | ${r.par||''} | ${r.score||''} | ${r.diff!==null?r.diff:''} | ${r.notes||''}`);
        if(r.holes && r.holes.length) {
          r.holes.forEach(h => {
            L.push(`  HISTORY-HOLE | ${h.n} | ${h.par||''} | ${h.score||''} | ${h.putts||''} | ${h.gir===true?'Y':h.gir===false?'N':''} | ${h.yards||''}`);
          });
          const hasShotData = r.holes.some(h => h.shots && h.shots.some(sh => sh.sg !== null && sh.sg !== undefined));
          if(hasShotData && window._lrRoundSG) {
            const sg = window._lrRoundSG(r.holes, r.holes);
            if(sg) L.push(`  HISTORY-SG | total=${sg.total} | OTT=${sg.OTT} | APP=${sg.APP} | ARG=${sg.ARG} | PUTT=${sg.PUTT}`);
          }
        }
      });
    }
  }

  const blob = new Blob([L.join('\n')], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `virtual-caddie-export-${today()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);

  if(st) {
    const tierName = {1:'Basic',2:'Standard',3:'Advanced',4:'Full'}[+optTier]||'Full';
    const cached = localStorage.getItem('vc:skill') ? '\u2713 skill cached' : '\u26A0 skill not cached \u2014 upload skill.md to AI manually';
    st.innerHTML = `Exported \u00B7 Tier ${optTier} (${tierName}) \u00B7 ${cached}`
      + `<br><span style="color:var(--tx2)">Upload the export file to your AI chat. When done, save the AI's session result as a .txt file and import it below.</span>`;
  }
  if(window.showAIStepsCard) window.showAIStepsCard('aiStepsForAI');
}

// -- Import Session Result ----------------------------------------------------
function _sniffResultType(text) {
  // Determine what data a session result contains from DATA CHANGES content
  const dataIdx = text.indexOf('--- DATA CHANGES ---');
  const dataSection = dataIdx !== -1 ? text.slice(dataIdx) : '';
  const sessionType = (text.match(/^Type:\s*(.+)/m)||[])[1]?.trim()||'';
  if(sessionType==='optimisation'||sessionType==='caddie'||sessionType==='both') return 'caddie';
  if(dataSection.match(/^ROUND \|/m)) return 'rounds';
  if(dataSection.match(/^COURSE \|/m)) return 'courses';
  if(dataSection.match(/^CLUB \|/m)) return 'clubs';
  return 'caddie'; // fallback -- let processSessionResult handle validation
}

function processSessionResult(text, expectedType) {
  // Returns {ok, summary} -- mutates bag/rounds/history and calls save()+renderAll()
  // expectedType: 'caddie'|'clubs'|'courses'|'rounds'|undefined (undefined = no validation)
  const lines = text.split('\n');
  if(!lines[0]?.trim().startsWith('=== VIRTUAL CADDIE SESSION ==='))
    return {ok:false, summary:'Not a valid session result.\nExpected first line: "=== VIRTUAL CADDIE SESSION ==="'};
  if(expectedType) {
    const sniffed = _sniffResultType(text);
    if(sniffed !== expectedType) {
      const labels = {caddie:'Caddie Session', clubs:'Club Setup', courses:'Course Lookup', rounds:'Round Logging'};
      return {ok:false, summary:`Wrong result type.\nThis looks like a ${labels[sniffed]||sniffed} result.\nImport it from the ${labels[sniffed]||sniffed} card in the GORDy tab.`};
    }
  }

  const sessionType = (text.match(/^Type:\s*(.+)/m)||[])[1]?.trim() || 'result';
  const sessionDate = (text.match(/^Date:\s*(.+)/m)||[])[1]?.trim() || today();

  let section=null, meta={}, caddieLines=[], dataLines=[];
  for(const raw of lines) {
    const line=raw.trim();
    if(line==='--- SESSION META ---')  { section='meta';   continue; }
    if(line==='--- CADDIE OUTPUT ---') { section='caddie'; continue; }
    if(line==='--- DATA CHANGES ---')  { section='data';   continue; }
    if(!line||line.startsWith('=')||line.startsWith('SessionVersion')||line.startsWith('Date:')||line.startsWith('Type:')) continue;
    if(section==='meta')   { const p=line.split('|').map(s=>s.trim()); if(p[0]) meta[p[0]]=p[1]||''; }
    else if(section==='caddie') caddieLines.push(raw);
    else if(section==='data')   dataLines.push(line);
  }
  while(caddieLines.length && !caddieLines[caddieLines.length-1].trim()) caddieLines.pop();

  // Extract HOLE-MAP block from caddie output before storing text
  let holeMap={};
  const hmStart=caddieLines.findIndex(l=>l.trim()==='HOLE-MAP');
  if(hmStart!==-1){
    const hmEnd=caddieLines.findIndex((l,i)=>i>hmStart&&l.trim()==='END-HOLE-MAP');
    const hmLines=caddieLines.slice(hmStart+1, hmEnd!==-1?hmEnd:undefined);
    hmLines.forEach(l=>{
      const line=l.trim();
      if(!line) return;
      // Format: H1|Driver,6H|5W,7H  -- hole num, then pipe-separated paths, clubs comma-sep
      const pipeIdx=line.indexOf('|');
      if(pipeIdx===-1) return;
      const n=parseInt(line.slice(0,pipeIdx).replace('H',''));
      if(!n) return;
      const paths=line.slice(pipeIdx+1).split('|').map(p=>p.split(',').filter(Boolean)).filter(p=>p.length);
      if(paths.length) holeMap[n]={paths};
    });
    // Remove HOLE-MAP block from displayed text
    caddieLines.splice(hmStart, hmEnd!==-1?hmEnd-hmStart+1:caddieLines.length-hmStart);
    while(caddieLines.length && !caddieLines[caddieLines.length-1].trim()) caddieLines.pop();
  }

  // Extract BAG-MAP block
  let bagMap=[];
  const bmStart=caddieLines.findIndex(l=>l.trim()==='BAG-MAP');
  if(bmStart!==-1){
    const bmEnd=caddieLines.findIndex((l,i)=>i>bmStart&&l.trim()==='END-BAG-MAP');
    const bmLines=caddieLines.slice(bmStart+1, bmEnd!==-1?bmEnd:undefined);
    bagMap=bmLines.map(l=>l.trim()).filter(Boolean);
    caddieLines.splice(bmStart, bmEnd!==-1?bmEnd-bmStart+1:caddieLines.length-bmStart);
    while(caddieLines.length && !caddieLines[caddieLines.length-1].trim()) caddieLines.pop();
  }

  history.unshift({
    id:uid(), date:sessionDate, type:sessionType,
    course:meta['COURSE']||'', tee:meta['TEE']||'',
    hcp:meta['HCP']||'', playHcp:meta['PLAYING_HCP']||'',
    conditions:meta['CONDITIONS']||'', holes:meta['HOLES']||'',
    optTier:meta['OPT_TIER']||'4',
    text:caddieLines.join('\n'),
    holeMap:Object.keys(holeMap).length?holeMap:undefined,
    bagMap:bagMap.length?bagMap:undefined
  });

  const changes=[];
  if(dataLines.length) {
    let curClub=null, curCourse=null, curTee=null;
    for(const line of dataLines) {
      // Profile fields from setup skill
      if(line.startsWith('PROFILE_NAME |'))    { const v=line.split('|')[1]?.trim(); if(v){profile.name=v;    changes.push('Updated name: '+v);} }
      else if(line.startsWith('PROFILE_HANDED |')) { const v=line.split('|')[1]?.trim(); if(v){profile.handed=v;  changes.push('Updated handed: '+v);} }
      else if(line.startsWith('PROFILE_YARDPREF |')){ const v=line.split('|')[1]?.trim(); if(v){profile.yardType=v;changes.push('Updated yardage preference: '+v);} }
      // Clubs
      else if(line.startsWith('CLUB |')) {
        const p=line.split('|').map(s=>s.trim());
        const existing=bag.find(c=>c.identifier===p[3]&&c.type===p[2]);
        if(!existing) {
          curClub={id:uid(),brand:p[1]||'',type:p[2]||'Iron',identifier:p[3]||'',stiffness:p[4]||'Regular',shaftLength:p[5]||'',tested:p[6]==='YES'||p[6]==='PUTTER',confidence:p[7]?parseInt(p[7]):4,bias:p[8]||'Straight',yardType:p[9]||'',loft:p[10]||'',model:p[11]||'',sessions:[]};
          bag.push(curClub);
          changes.push(`Added club: ${curClub.identifier}`);
        } else { curClub=existing; }
        curCourse=null; curTee=null;
      } else if(line.startsWith('SESSION |')&&curClub) {
        const p=line.split('|').map(s=>s.trim());
        curClub.sessions=curClub.sessions||[];
        curClub.sessions.push({id:uid(),date:p[1]||today(),min:p[2]||'',max:p[3]||'',notes:p[4]||''});
        changes.push(`Added session for ${curClub.identifier}`);
      }
      // Courses
      else if(line.startsWith('COURSE |')) {
        const p=line.split('|').map(s=>s.trim());
        const existing=courses.find(c=>c.name===p[2]);
        if(!existing) {
          curCourse={id:p[1]||uid(),name:p[2]||'',city:p[3]||'',par:p[4]||'',rating:p[5]||'',slope:p[6]||'',yardage:p[7]||'',selectedTee:p[8]||'',updatedAt:p[9]||today(),tees:[]};
          courses.push(curCourse);
          changes.push(`Added course: ${curCourse.name}`);
        } else { curCourse=existing; }
        curClub=null; curTee=null;
      } else if(line.startsWith('TEE |')&&curCourse) {
        const p=line.split('|').map(s=>s.trim());
        curTee={id:p[1]||uid(),name:p[2]||'',rating:p[3]||'',slope:p[4]||'',yardage:p[5]||'',holes:[]};
        curCourse.tees=curCourse.tees||[];
        const existingTee=curCourse.tees.find(t=>t.name===curTee.name);
        if(!existingTee) { curCourse.tees.push(curTee); changes.push(`Added tee: ${curTee.name} at ${curCourse.name}`); }
        else { curTee=existingTee; }
        if(!curCourse.selectedTee) curCourse.selectedTee=curTee.id;
      } else if(line.startsWith('HOLE |')&&curTee) {
        const p=line.split('|').map(s=>s.trim());
        curTee.holes=curTee.holes||[];
        /* GEO-SUM: geoSummary defaults to ''. If a GEO | line follows, the next branch attaches it. */
        curTee.holes.push({number:parseInt(p[1])||0,par:p[2]||'',yards:p[3]||'',handicap:p[4]||'',note:p[5]||'',geoSummary:''});
      } else if(line.trim().startsWith('GEO |')&&curTee&&curTee.holes&&curTee.holes.length) {
        /* GEO-SUM: GEO line attaches to the most recent hole on its tee. Used by both
           AI-export (caddie.js L329) and backup serialise (store.js). Trim because the
           export indents this line by 4 spaces. */
        curTee.holes[curTee.holes.length-1].geoSummary = line.trim();
      }
      // Rounds
      else if(line.startsWith('ROUND |')) {
        const p=line.split('|').map(s=>s.trim());
        curClub=null; curCourse=null; curTee=null;
        const nr={id:uid(),date:p[1]||today(),courseName:p[2]||'',tee:p[3]||'',rating:p[4]||'',slope:p[5]||'',par:p[6]||'',score:p[7]||'',diff:p[8]?parseFloat(p[8]):calcDiff(p[7],p[4],p[5]),notes:p[9]||'',sessionIds:[],holes:[]};
        rounds.push(nr);
        changes.push(`Logged round: ${p[2]} (${p[1]})`);
      } else if(line.startsWith('SESSIONIDS |')&&rounds.length) {
        rounds[rounds.length-1].sessionIds=line.replace(/^SESSIONIDS \| /,'').trim().split(',').filter(Boolean);
      } else if(line.startsWith('HOLE |')&&rounds.length) {
        const p=line.split('|').map(s=>s.trim());
        rounds[rounds.length-1].holes.push({n:parseInt(p[1])||0,par:p[2]||'',score:p[3]||'',putts:p[4]||'',gir:p[5]==='Y'?true:p[5]==='N'?false:null,notes:p[6]||'',yards:p[7]||''});
      }
    }
  }

  save(); renderAll();

  const summary = changes.length
    ? `Session imported.\n\nData changes:\n\u2022 ${changes.join('\n\u2022 ')}\n\nUse Save Data to back up your updated file.`
    : 'Session imported. Use Save Data to back up your updated file.';
  return {ok:true, summary};
}

function toggleCard(id){
  const body=document.getElementById(id+'-body');
  const hdr=document.getElementById(id+'-hdr');
  if(!body) return;
  const open=body.style.display==='none';
  body.style.display=open?'block':'none';
  hdr?.classList.toggle('open',open);
}

function _fileImport(e, expectedType, pasteId) {
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{ const r=processSessionResult(ev.target.result, expectedType); alert(r.summary); if(r.ok && window.hideAIStepsCard) window.hideAIStepsCard(pasteId); };
  reader.readAsText(file);
  e.target.value='';
}

function _pasteImport(pasteId, expectedType) {
  const ta=document.getElementById(pasteId);
  const text=(ta?.value||'').trim();
  if(!text){alert('Paste your result text first.');return;}
  const r=processSessionResult(text, expectedType);
  alert(r.summary);
  if(r.ok&&ta) ta.value='';
  if(r.ok && window.hideAIStepsCard) window.hideAIStepsCard(pasteId);
}

// Per-card file importers
function importCaddieResult(e){ _fileImport(e,'caddie','pasteResult'); }
function importClubResult(e)  { _fileImport(e,'clubs','pasteClubResult'); }
function importCourseResult(e){ _fileImport(e,'courses','pasteCourseResult'); }
function importRoundResult(e) { _fileImport(e,'rounds','pasteRoundResult'); }
// Per-card paste importers
function importPastedCaddieResult(){ _pasteImport('pasteResult','caddie'); }
function importPastedClubResult()  { _pasteImport('pasteClubResult','clubs'); }
function importPastedCourseResult(){ _pasteImport('pasteCourseResult','courses'); }
function importPastedRoundResult() { _pasteImport('pasteRoundResult','rounds'); }
// Legacy aliases
function importSessionResult(e){ _fileImport(e,undefined,'pasteResult'); }
function importPastedResult(){ _pasteImport('pasteResult',undefined); }

// -- Phase 5.1 - Session Scorecard PDF ----------------------------------------
async function exportSessionPdf(id) {
  const h = history.find(x=>x.id===id);
  if(!h) return;
  const logo = window._pdfLogoDataUrl ? await window._pdfLogoDataUrl() : '';
  const lines = (h.text||'').split('\n');

  // Parse session text into sections
  let bagLines=[], putterLine='', leftOut='', gaps='', stratLines=[], fittingLine='', holeLines=[];
  for(const raw of lines) {
    const l=raw.trim();
    if(!l||l.startsWith('OPTIMISED BAG')||l.startsWith('Total:')) continue;
    if(l==='COURSE STRATEGY'||l==='HOLE-BY-HOLE') continue;
    if(l.startsWith('FITTING INSIGHT')) { fittingLine=l; continue; }
    if(l.startsWith('LEFT OUT:'))       { leftOut=l.replace('LEFT OUT:','').trim(); continue; }
    if(l.startsWith('YARDAGE GAPS:'))   { gaps=l.replace('YARDAGE GAPS:','').trim(); continue; }
    if(/^H\d+\s*\|/.test(l))           { holeLines.push(l); continue; }
    if(/^\d+\.\s+/.test(l))            { bagLines.push(l); continue; }
    if(l.startsWith('+'))              { putterLine=l.replace(/^\+\s*/,''); continue; }
    if(/^\d+\.\s/.test(l) && holeLines.length===0 && bagLines.length>0) { stratLines.push(l); continue; }
    // Strategy lines appear after bag list and before holes
    if(bagLines.length>0 && holeLines.length===0 && /^\d+\./.test(l)) stratLines.push(l);
  }

  // Bag table
  const bagRows = bagLines.map(l=>{
    const m=l.match(/^(\d+)\.\s+(.+?)\s+\u2014\s+([0-9\u2013\-]+ yds)\s+(.+)/);
    if(!m) return `<tr><td colspan="4" style="color:#5a6e52;font-size:.68rem">${escHtml(l)}</td></tr>`;
    return `<tr><td style="color:#2d5127;font-weight:600;width:24px">${m[1]}.</td><td>${escHtml(m[2])}</td><td style="text-align:center;white-space:nowrap;color:#3d6b35">${escHtml(m[3])}</td><td style="color:#5a6e52;font-size:.63rem">${escHtml(m[4])}</td></tr>`;
  }).join('');

  // Scorecard rows -- insert OUT/IN/TOTAL subtotals at holes 9, 18
  const scRows = holeLines.map((l,i)=>{
    const p=l.split('|').map(s=>s.trim());
    const num  =(p[0]||'').replace(/^H/,'').trim();
    const par  =(p[1]||'').replace('Par ','').trim();
    const yds  =(p[2]||'').replace(' yds','').trim();
    const strks=(p[4]||'').trim();
    const advice=p.slice(5).filter(Boolean).join(' \u00B7 ');
    const parN =parseInt(par)||0;
    const bg   =parN===3?'#edf3f7':parN===5?'#fff8ee':'#fff';
    const row=`<tr style="background:${bg}">
      <td style="text-align:center;font-weight:700;color:#2d5127">${escHtml(num)}</td>
      <td style="text-align:center">${escHtml(par)}</td>
      <td style="text-align:center">${escHtml(yds)}</td>
      <td style="font-size:.62rem;color:#3d6b35">${escHtml(strks)}</td>
      <td style="font-size:.62rem">${escHtml(advice)}</td>
      <td style="border-left:2px solid #3d6b35;background:#fffdf8" contenteditable="true"></td>
      <td style="border-left:1px solid #ddd5c4;background:#fffdf8" contenteditable="true"></td>
    </tr>`;
    const sub = (i===8||i===17) ? `<tr style="background:#e8f0e5">
      <td colspan="5" style="text-align:right;font-size:.58rem;font-weight:700;color:#2d5127;padding:3px 7px">${i===8?'OUT':'IN'}</td>
      <td style="border-left:2px solid #3d6b35;border-top:2px solid #3d6b35;background:#e8f0e5"></td>
      <td style="border-left:1px solid #ddd5c4;border-top:1px solid #ddd5c4;background:#e8f0e5"></td>
    </tr>` : '';
    const total = i===17 ? `<tr style="background:#2d5127;color:#fff">
      <td colspan="5" style="text-align:right;font-size:.6rem;font-weight:700;padding:4px 7px">TOTAL</td>
      <td style="border-left:2px solid #3d6b35;background:#1e3a1a"></td>
      <td style="border-left:1px solid rgba(255,255,255,.3);background:#1e3a1a"></td>
    </tr>` : '';
    return row+sub+total;
  }).join('');

  const meta=[
    h.tee?h.tee+' tees':'',
    h.hcp&&h.hcp!=='not set'?'HCP '+h.hcp:'',
    h.playHcp&&h.playHcp!=='not computed'?'Playing HCP '+h.playHcp:'',
    h.conditions&&h.conditions!=='calm'?h.conditions:'',
    h.holes&&h.holes!=='all 18'?h.holes:'',
  ].filter(Boolean).join(' \u00B7 ');

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Gordy \u2014 ${escHtml(h.course||'Session')}</title>
${window._pdfFontsLink||''}
${window._pdfSharedCSS?window._pdfSharedCSS():'<style>body{font-family:monospace;padding:24px;}</style>'}
<style>
.detail{font-size:.62rem;color:#5a6e52;margin-top:7px;line-height:1.6;}
.strat{font-size:.68rem;color:#2c3a28;line-height:1.65;margin-bottom:3px;}
.hero-date{font-size:.6rem;color:#8a9e82;white-space:nowrap;}
</style>
</head><body>
<button class="print-btn no-print" onclick="window.print()">\uD83D\uDDA8 Print / Save PDF</button>
${window._pdfBanner?window._pdfBanner(profile.name||'',getHandicap(),logo):''}
<div class="hero">
  <div><div class="hero-title">\u26F3 ${escHtml(h.course||'Session')}</div><div class="hero-meta">${escHtml(meta)}</div></div>
  <div class="hero-date">${escHtml(h.date||'')}</div>
</div>

${bagLines.length?`<div class="card">
  <h3>Optimised Bag</h3>
  <table><thead><tr><th>#</th><th>Club</th><th>Range</th><th>Role</th></tr></thead><tbody>${bagRows}</tbody></table>
  ${putterLine?`<div class="detail">+ ${escHtml(putterLine)}</div>`:''}
  ${leftOut?`<div class="detail"><strong>Left out:</strong> ${escHtml(leftOut)}</div>`:''}
  ${gaps?`<div class="detail"><strong>Gaps:</strong> ${escHtml(gaps)}</div>`:''}
</div>`:''}

${stratLines.length?`<div class="card">
  <h3>Course Strategy</h3>
  ${stratLines.map(s=>`<div class="strat">${escHtml(s)}</div>`).join('')}
  ${fittingLine?`<div class="detail">${escHtml(fittingLine)}</div>`:''}
</div>`:''}

${holeLines.length?`<div class="card page-break">
  <h3>Hole-by-Hole \u00B7 Score &amp; Notes</h3>
  <table>
    <thead><tr>
      <th style="width:32px;text-align:center">Hole</th>
      <th style="width:28px;text-align:center">Par</th>
      <th style="width:40px;text-align:center">Yds</th>
      <th style="width:80px">Strokes</th>
      <th>Caddie Advice</th>
      <th style="width:50px;text-align:center;border-left:2px solid #3d6b35">Score</th>
      <th style="width:130px;border-left:1px solid #ddd5c4">Notes</th>
    </tr></thead>
    <tbody>${scRows}</tbody>
  </table>
</div>`:''}

<div class="footer">Virtual Caddie \u00B7 ${escHtml(h.course||'')} \u00B7 Generated ${new Date().toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'})}</div>
</body></html>`;

const w = window.open('','_blank');
if(w){ w.document.open(); w.document.write(html); w.document.close(); }
}

// -- Phase 4.1 - Starter TXT --------------------------------------------------
function exportStarterTxt() {
  const setupText = getSetupSkillText();
  const ver = (setupText.match(/SetupSkillVersion:\s*(\d+)/)||[])[1]||'?';
  const lines = [
    '=== VIRTUAL CADDIE SETUP ===',
    'SetupVersion: 1',
    `SetupSkillVersion: ${ver}`,
    `ExportDate: ${today()}`,
    `AppVersion: ${APP_VERSION}`,
    '',
    '=== SETUP INSTRUCTIONS ===',
    setupText,
    '',
    '=== DATA ===',
    '',
    '--- PROFILE ---',
    'NAME | '    +(profile.name||''),
    'AGE | '     +(profile.age||''),
    'GENDER | '  +(profile.gender||''),
    'HANDED | '  +(profile.handed||''),
    'YARDPREF | '+(profile.yardType||'Total'),
    '',
    '--- CLUBS ---',
    '',
    '--- COURSES ---',
    '',
    '--- HANDICAP ---',
    'MODE | calculated',
    'ACTIVE | not set',
  ];
  const blob = new Blob([lines.join('\n')], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'virtual-caddie-setup-'+today()+'.txt';
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById('uploadBanner').style.display = 'none';
}

// -- Phase 4.5 - Task Exports -------------------------------------------------
function downloadTask(filename, content) {
  const blob = new Blob([content], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportClubTask() {
  // Build dynamic user-data sections
  const clubLines = ['=== CURRENT CLUBS ==='];
  bag.forEach(c => {
    const opt = c.type==='Putter'?'PUTTER':c.tested?'YES':'NO';
    clubLines.push('CLUB | '+[c.brand||'',c.type,c.identifier||'',c.stiffness,c.shaftLength||'',opt,c.confidence??4,c.bias||'Straight',c.yardType||'',c.loft||'',c.model||''].join(' | '));
    (c.sessions||[]).forEach(s=>clubLines.push('  SESSION | '+s.date+' | '+s.min+' | '+s.max));
  });
  if(bag.length===0) clubLines.push('# No clubs saved yet.');

  const taskText = getClubTaskText();
  const ver = (taskText.match(/ClubTaskVersion:\s*(\d+)/)||[])[1]||'?';

  const content = `=== VIRTUAL CADDIE TASK ===
TaskType: add-clubs
Date: ${today()}
AppVersion: ${APP_VERSION}
ClubTaskVersion: ${ver}

--- TASK INSTRUCTIONS ---
${taskText}

--- USER DATA ---
${clubLines.join('\n')}`;

  downloadTask(`vc-club-task-${today()}.txt`, content);
  if(window.showAIStepsCard) window.showAIStepsCard('aiStepsClub');
}

function exportCourseTask() {
  const existingNames = courses.map(c=>c.name).filter(Boolean);
  const existingLine = existingNames.length
    ? '# Already saved: '+existingNames.join(', ')
    : '# No courses saved yet.';

  const taskText = getCourseTaskText();
  const ver = (taskText.match(/CourseTaskVersion:\s*(\d+)/)||[])[1]||'?';

  // If a repo course was pre-loaded for this session, embed it so AI skips web search
  const preLoadedId = localStorage.getItem('gordy:courseTask:preloaded');
  let preLoadedBlock = '';
  if(preLoadedId) {
    const cached = localStorage.getItem('gordy:course:'+preLoadedId);
    if(cached) {
      const c = _stripGeometry(JSON.parse(cached));
      const teeLines = (c.tees||[]).map(t=>{
        const holes = (t.holes||[]).map(h=>{
          const base = `    HOLE | ${h.number} | ${h.par||''} | ${h.yards||''} | ${h.handicap||''}`;
          return h.geoSummary ? base + '\n    ' + h.geoSummary : base; /* GEO-SUM */
        }).join('\n');
        return `  TEE | ${t.id} | ${t.name} | ${t.rating||''} | ${t.slope||''} | ${t.totalYards||t.yardage||''}\n${holes}`;
      }).join('\n');
      preLoadedBlock = `\n\n--- PRE-LOADED COURSE DATA ---\n# Official data from Gordy repo \u2014 use as starting point, skip web search, confirm tees with user\nCOURSE | ${c.courseId||c.id} | ${c.name} | ${c.city||''} | ${c.par||''} | ${c.rating||''} | ${c.slope||''} | ${c.totalYards||c.yardage||''} | ${c.selectedTee||''} | ${c.updated||c.updatedAt||''}\n${teeLines}`;
    }
    localStorage.removeItem('gordy:courseTask:preloaded');
  }

  const content = `=== VIRTUAL CADDIE TASK ===
TaskType: add-course
Date: ${today()}
AppVersion: ${APP_VERSION}
CourseTaskVersion: ${ver}

--- TASK INSTRUCTIONS ---
${taskText}

--- USER DATA ---
=== CURRENT COURSES ===
${existingLine}${preLoadedBlock}`;

  downloadTask(`vc-course-task-${today()}.txt`, content);
  if(window.showAIStepsCard) window.showAIStepsCard('aiStepsCourse');
}

Object.assign(window, {
  updateCourseSelects, updateCadTees, renderAIHelp, renderSessions,
  toggleSession, toggleRangeSession, deleteCaddieSession, deleteRangeSession, renderHistory,
  confirmDeleteRangeSession, confirmDeleteCaddieSession,
  exportForAI, toggleCard,
  fmtDate, deriveStats,
  importCaddieResult, importClubResult, importCourseResult, importRoundResult,
  importPastedCaddieResult, importPastedClubResult, importPastedCourseResult, importPastedRoundResult,
  importSessionResult, importPastedResult,
  exportSessionPdf, exportStarterTxt, downloadTask, exportClubTask, exportCourseTask,
  getRoundTaskText
});
