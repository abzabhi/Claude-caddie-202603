import { uid, today, save, courses, rounds, profile, removeCourse, replaceCourse } from './store.js';
import { setVizInitDone } from './viz.js';

const GORDY_COURSES_INDEX_URL = 'https://raw.githubusercontent.com/abzabhi/gordy-courses/main/index.json';
const GORDY_COURSES_BASE_URL  = 'https://raw.githubusercontent.com/abzabhi/gordy-courses/main/courses/';

let editCourseData = null;
let currentEditTeeId = null;

async function _fetchCourseIndex() {
  const CACHE_KEY='gordy:courseIndex', CACHE_TS='gordy:courseIndex:ts', TTL=24*60*60*1000;
  const cached=localStorage.getItem(CACHE_KEY);
  const ts=parseInt(localStorage.getItem(CACHE_TS)||'0');
  if(cached&&(Date.now()-ts)<TTL) return JSON.parse(cached);
  try {
    const r=await fetch(GORDY_COURSES_INDEX_URL,{cache:'no-store'});
    if(!r.ok) return cached?JSON.parse(cached):[];
    const data=await r.json();
    localStorage.setItem(CACHE_KEY,JSON.stringify(data));
    localStorage.setItem(CACHE_TS,String(Date.now()));
    return data;
  } catch { return cached?JSON.parse(cached):[]; }
}

async function _fetchCourseFile(courseId) {
  const CACHE_KEY='gordy:course:'+courseId;
  const cached=localStorage.getItem(CACHE_KEY);
  if(cached) return JSON.parse(cached);
  try {
    const r=await fetch(GORDY_COURSES_BASE_URL+courseId+'.json');
    if(!r.ok) return {_fetchError:r.status};
    const data=await r.json();
    localStorage.setItem(CACHE_KEY,JSON.stringify(data));
    return data;
  } catch(e) { return {_fetchError:'network',_msg:e.message}; }
}

function _stripGeometry(courseObj) {
  if(!courseObj) return courseObj;
  const {geometry,...clean}=courseObj;
  return clean;
}

async function searchCourseRepo(query) {
  const index=await _fetchCourseIndex();
  const q=query.trim().toLowerCase();
  if(!q) return [];
  return index.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.city||'').toLowerCase().includes(q));
}

async function addCourseFromRepo(courseId,statusElId) {
  const st=statusElId?document.getElementById(statusElId):null;
  if(st) st.textContent='Fetching course data...';
  const data=await _fetchCourseFile(courseId);
  if(!data||data._fetchError){
    const e=data?._fetchError;
    const msg=e===404?'\u26A0 Course file not found in repo (404).':e==='network'?`\u26A0 Network error -- ${data._msg||'check connection'}.`:`\u26A0 Fetch failed (${e}) -- check connection.`;
    if(st) st.textContent=msg;
    return;
  }
  const course={
    id:         data.courseId||data.id||courseId,
    name:       data.name||'',
    city:       data.city||'',
    par:        data.par||'',
    rating:     data.rating||'',
    slope:      data.slope||'',
    yardage:    data.totalYards||data.yardage||'',
    selectedTee:data.selectedTee||'',
    updatedAt:  data.updated||data.updatedAt||today(),
    tees:(data.tees||[]).map(t=>({
      id:t.id, name:t.name,
      rating:t.rating||'', slope:t.slope||'',
      yardage:t.totalYards||t.yardage||'',
      holes:(t.holes||[]).map(h=>({number:h.number,par:h.par||'',yards:h.yards||'',handicap:h.handicap||'',note:h.note||''}))
    }))
  };
  const selTee=course.tees.find(t=>t.id===course.selectedTee);
  if(selTee) course.holes=selTee.holes;
  const existing=courses.find(c=>c.id===course.id);
  if(existing){
    if(!confirm(`"${course.name}" is already in your courses. Replace with the repo version?`)) return;
    replaceCourse(course);
  } else {
    courses.push(course);
  }
  save(); renderAll();
  if(st) st.textContent=`\u2705 "${course.name}" added to your courses.`;
}

function getFavCourseId() {
  if(!rounds.length) return null;
  const counts = {};
  rounds.forEach(r=>{ if(r.courseName) counts[r.courseName]=(counts[r.courseName]||0)+1; });
  const topName = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0];
  if(!topName) return null;
  return courses.find(c=>c.name===topName)?.id || null;
}

export function renderCourseList() {
  document.getElementById('coursesBadge').textContent = courses.length;
  const dl = document.getElementById('homeClubList');
  if(dl) dl.innerHTML = courses.map(c=>`<option value="${c.name}">`).join('');
  if(!courses.length){
    document.getElementById('courseCards').innerHTML='<div class="hist-empty">No courses saved yet.</div>';
    updateCourseSelects(); return;
  }
  const homeId = profile.homeCourseId||null;
  const favId  = getFavCourseId();
  const sorted = [...courses].sort((a,b)=>{
    const aHome=a.id===homeId, bHome=b.id===homeId;
    const aFav =a.id===favId,  bFav =b.id===favId;
    if(aHome&&!bHome) return -1; if(bHome&&!aHome) return 1;
    if(aFav&&!bFav)  return -1; if(bFav&&!aFav)  return 1;
    return (a.name||'').localeCompare(b.name||'');
  });
  document.getElementById('courseCards').innerHTML = sorted.map(c=>{
    const isHome = c.id===homeId;
    const isFav  = c.id===favId && c.id!==homeId;
    const pinHTML = isHome ? `<span class="course-pin home">\uD83C\uDFE0 Home</span>`
                  : isFav  ? `<span class="course-pin fav">\u2B50 Favourite</span>` : '';
    const cardCls = isHome?'course-card is-home':isFav?'course-card is-fav':'course-card';
    const togLbl  = isHome ? '\uD83C\uDFE0 Home Course' : 'Set as Home';
    const togCls  = isHome ? 'home-tog active' : 'home-tog';
    return `
      <div class="${cardCls}" onclick="editCourse('${c.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="min-width:0">
            <div class="course-name">${pinHTML}${c.name||'Unnamed'}</div>
            <div class="course-meta">${c.city?c.city+' \u00B7 ':''}Par ${c.par} \u00B7 ${c.yardage}yds \u00B7 Rating ${c.rating}/Slope ${c.slope}${c.tees?.length?' \u00B7 '+c.tees.length+' tees':''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
            <button class="${togCls}" onclick="event.stopPropagation();toggleHomeCourse('${c.id}')">${togLbl}</button>
            <button class="btn danger" style="font-size:.62rem;padding:4px 8px" onclick="event.stopPropagation();deleteCourse('${c.id}')">Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');
  const dl2 = document.getElementById('savedCoursesList');
  if(dl2) dl2.innerHTML = courses.map(c=>`<option value="${c.name}">`).join('');
  updateCourseSelects();
}

function deleteCourse(id) {
  removeCourse(id);
  if(profile.homeCourseId===id){profile.homeCourseId='';save();}
  save();
  setVizInitDone(false);
  renderCourseList();
}

function toggleHomeCourse(id) {
  profile.homeCourseId = profile.homeCourseId===id ? '' : id;
  const c = courses.find(x=>x.id===profile.homeCourseId);
  profile.homeClub = c ? c.name : profile.homeClub;
  const el = document.getElementById('pfHomeClubSelect');
  if(el && profile.homeCourseId) {
    el.value = profile.homeCourseId;
    const hci = document.getElementById('pfHomeClub'); if(hci) hci.style.display='none';
  } else if(el) {
    el.value='';
  }
  renderCourseList();
  renderProfileHero();
}

function editCourse(id) {
  const foundCourse = id ? courses.find(c=>c.id===id) : null;
  if(id && !foundCourse) return;
  editCourseData = foundCourse
    ? JSON.parse(JSON.stringify(foundCourse))
    : {id:uid(),name:'',city:'',par:'72',rating:'',slope:'',yardage:'',tees:[],selectedTee:'',holes:Array.from({length:18},(_,i)=>({number:i+1,par:'4',yards:'',handicap:''}))};
  currentEditTeeId = editCourseData.selectedTee||editCourseData.tees[0]?.id||null;
  document.getElementById('courseListView').style.display='none';
  document.getElementById('courseEditView').style.display='block';
  document.getElementById('courseEditTitle').textContent = id?'Edit Course':'New Course';
  document.getElementById('cName').value=editCourseData.name||'';
  document.getElementById('cCity').value=editCourseData.city||'';
  document.getElementById('cRating').value=editCourseData.rating||'';
  document.getElementById('cSlope').value=editCourseData.slope||'';
  document.getElementById('cPar').value=editCourseData.par||'';
  document.getElementById('cYardage').value=editCourseData.yardage||'';
  renderTeeButtons(); renderHoleTable();
}

function cancelCourseEdit() {
  editCourseData=null;
  document.getElementById('courseListView').style.display='block';
  document.getElementById('courseEditView').style.display='none';
}

function renderTeeButtons() {
  if(!editCourseData) return;
  const btns = document.getElementById('teeButtons');
  btns.innerHTML = editCourseData.tees.map(t=>`
    <div style="display:inline-flex;align-items:stretch;margin:0 4px 4px 0;border-radius:3px;overflow:hidden;border:1px solid ${t.id===currentEditTeeId?'var(--gr2)':'var(--br2)'};">
      <button style="background:${t.id===currentEditTeeId?'var(--gr)':'var(--sf)'};color:${t.id===currentEditTeeId?'var(--ac2)':'var(--tx2)'};border:none;padding:5px 10px;font-family:'IBM Plex Mono',monospace;font-size:.67rem;cursor:pointer;" onclick="selectEditTee('${t.id}')">
        ${t.name}${t.yardage?` <span style="opacity:.6;font-size:.58rem;">(${t.yardage})</span>`:''}
      </button>
      <button title="Delete tee" onclick="deleteTee('${t.id}')" style="background:${t.id===currentEditTeeId?'rgba(0,0,0,.2)':'var(--sf)'};border:none;border-left:1px solid var(--br);color:var(--tx3);cursor:pointer;padding:5px 7px;font-size:.65rem;" onmouseover="this.style.color='var(--danger)'" onmouseout="this.style.color='var(--tx3)'">\u2715</button>
    </div>`).join('');
}

function showAddTeeRow() {
  document.getElementById('teeEditRow').style.display='flex';
  document.getElementById('addTeeBtn').style.display='none';
  document.getElementById('teeNameInput').focus();
}

function cancelAddTee() {
  document.getElementById('teeEditRow').style.display='none';
  document.getElementById('addTeeBtn').style.display='inline-block';
  ['teeNameInput','teeRatingInput','teeSlopeInput','teeYardageInput'].forEach(id=>{document.getElementById(id).value='';});
}

function confirmAddTee() {
  const name = document.getElementById('teeNameInput').value.trim();
  if(!name){alert('Please enter a tee name.');return;}
  if(currentEditTeeId && editCourseData) {
    const cur = editCourseData.tees.find(t=>t.id===currentEditTeeId);
    if(cur) cur.holes = editCourseData.holes.map(h=>({...h}));
  }
  const rating = document.getElementById('teeRatingInput').value.trim();
  const slope  = document.getElementById('teeSlopeInput').value.trim();
  const yardage= document.getElementById('teeYardageInput').value.trim();
  const templateHoles = editCourseData.tees[0]?.holes
    ? editCourseData.tees[0].holes.map(h=>({...h, yards:''}))
    : Array.from({length:18},(_,i)=>({number:i+1,par:'4',yards:'',handicap:''}));
  const newTee = {id:uid(), name, rating, slope, yardage, holes: templateHoles};
  editCourseData.tees.push(newTee);
  currentEditTeeId = newTee.id;
  editCourseData.holes = templateHoles.map(h=>({...h}));
  document.getElementById('cRating').value=rating;
  document.getElementById('cSlope').value=slope;
  document.getElementById('cYardage').value=yardage;
  cancelAddTee();
  renderTeeButtons(); renderHoleTable();
}

function deleteTee(id) {
  if(editCourseData.tees.length<=1){alert('A course must have at least one tee.');return;}
  if(!confirm('Delete this tee and its hole data?')) return;
  editCourseData.tees = editCourseData.tees.filter(t=>t.id!==id);
  if(currentEditTeeId===id) {
    currentEditTeeId = editCourseData.tees[0].id;
    const t = editCourseData.tees[0];
    editCourseData.holes = t.holes.map(h=>({...h}));
    document.getElementById('cRating').value=t.rating;
    document.getElementById('cSlope').value=t.slope;
    document.getElementById('cYardage').value=t.yardage;
  }
  renderTeeButtons(); renderHoleTable();
}

function selectEditTee(id) {
  if(currentEditTeeId && editCourseData) {
    const cur = editCourseData.tees.find(t=>t.id===currentEditTeeId);
    if(cur) cur.holes = editCourseData.holes.map(h=>({...h}));
  }
  currentEditTeeId = id;
  const tee = editCourseData.tees.find(t=>t.id===id);
  if(tee){
    editCourseData.rating=tee.rating;editCourseData.slope=tee.slope;editCourseData.yardage=tee.yardage;
    editCourseData.holes=tee.holes.map(h=>({...h}));
    document.getElementById('cRating').value=tee.rating;
    document.getElementById('cSlope').value=tee.slope;
    document.getElementById('cYardage').value=tee.yardage;
  }
  renderTeeButtons(); renderHoleTable();
}

function renderHoleTable() {
  if(!editCourseData) return;
  const tbody = document.getElementById('holeTableBody');
  tbody.innerHTML = editCourseData.holes.map(h=>`
    <tr>
      <td style="color:var(--tx3)">${h.number}</td>
      <td><input value="${h.par}" onchange="updateHole(${h.number},'par',this.value)" placeholder="4"></td>
      <td><input value="${h.yards}" onchange="updateHole(${h.number},'yards',this.value)" placeholder="380"></td>
      <td><input value="${h.handicap}" onchange="updateHole(${h.number},'handicap',this.value)" placeholder="9"></td>
    </tr>`).join('');
  updateHoleTotals();
}

function updateHole(num,field,val) {
  if(!editCourseData) return;
  const h=editCourseData.holes.find(x=>x.number===num);
  if(h) h[field]=val;
  if(currentEditTeeId){const t=editCourseData.tees.find(x=>x.id===currentEditTeeId);if(t)t.holes=editCourseData.holes.map(x=>({...x}));}
  updateHoleTotals();
}

function updateHoleTotals() {
  if(!editCourseData) return;
  document.getElementById('parTotal').textContent=editCourseData.holes.reduce((s,h)=>s+(+h.par||0),0)||'--';
  document.getElementById('yardsTotal').textContent=editCourseData.holes.reduce((s,h)=>s+(+h.yards||0),0)||'--';
}

function saveCourse() {
  if(!editCourseData) return;
  editCourseData.name=document.getElementById('cName').value;
  editCourseData.city=document.getElementById('cCity').value;
  editCourseData.rating=document.getElementById('cRating').value;
  editCourseData.slope=document.getElementById('cSlope').value;
  editCourseData.par=document.getElementById('cPar').value;
  editCourseData.yardage=document.getElementById('cYardage').value;
  if(currentEditTeeId){const t=editCourseData.tees.find(x=>x.id===currentEditTeeId);if(t)t.holes=editCourseData.holes.map(h=>({...h}));}
  if(!editCourseData.tees.length) {
    const defaultTee = {
      id: uid(), name: 'Standard',
      rating: editCourseData.rating,
      slope:  editCourseData.slope,
      yardage:editCourseData.yardage,
      holes:  editCourseData.holes.map(h=>({...h}))
    };
    editCourseData.tees.push(defaultTee);
    currentEditTeeId = defaultTee.id;
  }
  if(currentEditTeeId) editCourseData.selectedTee = currentEditTeeId;
  editCourseData.updatedAt = new Date().toISOString().slice(0,10);
  const idx=courses.findIndex(c=>c.id===editCourseData.id);
  if(idx>=0) courses[idx]=editCourseData; else courses.push(editCourseData);
  save(); setVizInitDone(false); cancelCourseEdit(); renderCourseList();
}

async function onRepoSearch() {
  const input=document.getElementById('repoSearchInput');
  const status=document.getElementById('repoSearchStatus');
  const results=document.getElementById('repoSearchResults');
  if(!input||!status||!results) return;
  const q=input.value.trim();
  if(!q){status.textContent='Enter a course name or city to search.'; return;}
  status.textContent='Searching...'; results.innerHTML='';
  const matches=await searchCourseRepo(q);
  if(!matches.length){
    status.textContent='Not found in repo -- use the AI export below.';
    return;
  }
  status.textContent=matches.length+' match'+(matches.length===1?'':'es')+' found:';
  results.innerHTML=matches.map(c=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--bg);border:1px solid var(--br);border-radius:4px;margin-bottom:5px;gap:8px">
      <div>
        <div style="font-size:.72rem;color:var(--tx);font-weight:600">${escHtml(c.name)}</div>
        <div style="font-size:.62rem;color:var(--tx3)">${escHtml(c.city||'')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn sec" style="font-size:.62rem;padding:4px 8px"
          onclick="localStorage.setItem('gordy:courseTask:preloaded','${c.courseId}');exportCourseTask();document.getElementById('repoSearchStatus').textContent='Pre-loaded \u2014 exporting for AI\u2026'">
          \uD83E\uDD16 Export with data
        </button>
        <button class="btn gold" style="font-size:.62rem;padding:4px 8px"
          onclick="addCourseFromRepo('${c.courseId}','repoSearchStatus');document.getElementById('repoSearchResults').innerHTML=''">
          \u2705 Add to my courses
        </button>
      </div>
    </div>`).join('');
}

export {
  getFavCourseId, renderCourseList, deleteCourse, toggleHomeCourse,
  editCourse, cancelCourseEdit, renderTeeButtons, showAddTeeRow,
  cancelAddTee, confirmAddTee, deleteTee, selectEditTee,
  renderHoleTable, updateHole, updateHoleTotals, saveCourse,
  _fetchCourseIndex, _fetchCourseFile, _stripGeometry,
  searchCourseRepo, addCourseFromRepo, onRepoSearch
};

Object.assign(window, {
  renderCourseList, deleteCourse, toggleHomeCourse, editCourse,
  cancelCourseEdit, showAddTeeRow, cancelAddTee, confirmAddTee,
  deleteTee, selectEditTee, updateHole, updateHoleTotals, saveCourse,
  addCourseFromRepo, onRepoSearch, _stripGeometry
});
Object.assign(window, { cancelAddTee, cancelCourseEdit, confirmAddTee, editCourse, onRepoSearch, saveCourse, showAddTeeRow });
