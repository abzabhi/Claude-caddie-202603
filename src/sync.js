import { serialise, save, bag, courses, rounds, history } from './store.js';

const MASTER_GIST_RAW = 'https://gist.githubusercontent.com/abzabhi/e91a5f6d85e17ab75b1defaa5fc9dab9/raw/';
const APP_LATEST_FILE = 'golf-caddie-latest.html';

// -- Gordy Sync -- encrypted D1 via Cloudflare Worker
const GORDY_SYNC_URL = 'https://gordy-sync.gordythevirtualcaddie.workers.dev/sync/';

let lastAutoPushTime = 0;

function kvId()  { return localStorage.getItem('vc:kvId')||''; }
function kvMode(){ return !!kvId(); }

// PBKDF2 key derivation from passphrase + salt
async function _kdfKey(passphrase, saltBuf) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt:saltBuf, iterations:200000, hash:'SHA-256'},
    raw, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']
  );
}

// Encrypt serialised data -- returns base64-encoded JSON envelope
async function _encrypt(plaintext, passphrase) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await _kdfKey(passphrase, salt);
  const ct   = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, enc.encode(plaintext));
  const b64  = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return JSON.stringify({v:1, salt:b64(salt), iv:b64(iv), ct:b64(ct)});
}

// Decrypt envelope -- returns plaintext string or throws
async function _decrypt(envelope, passphrase) {
  const {salt, iv, ct} = JSON.parse(envelope);
  const dec = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
  const key = await _kdfKey(passphrase, dec(salt));
  const buf = await crypto.subtle.decrypt({name:'AES-GCM', iv:dec(iv)}, key, dec(ct));
  return new TextDecoder().decode(buf);
}

// Generate a new GRD-xxxxxx ID
function _genSyncId() {
  const chars='abcdefghijklmnopqrstuvwxyz0123456789';
  let s='GRD-';
  const r=crypto.getRandomValues(new Uint8Array(6));
  r.forEach(b=>s+=chars[b%chars.length]);
  return s;
}

// Format lockout message with unlock time
function _fmtLockout(locked_until) {
  if(!locked_until) return '\uD83D\uDD12 Account locked. Try again later.';
  return '\uD83D\uDD12 Locked until '+new Date(locked_until).toLocaleTimeString()+'. Too many failed attempts.';
}

// Report successful auth to Worker (resets failed_attempts) -- fire and forget
async function _reportSuccess(id) {
  try { await fetch(GORDY_SYNC_URL+'report-success/'+id, {method:'POST'}); } catch {}
}

// Report failed decryption to Worker -- returns locked_until string if locked, else null
async function _reportFailure(id) {
  try {
    const r=await fetch(GORDY_SYNC_URL+'report-failure/'+id, {method:'POST'});
    if(r.ok){ const j=await r.json(); return j.locked_until||null; }
  } catch {}
  return null;
}

/* -- OLD kvPush (KV era) -- commented out, not deleted
async function kvPush(statusElId) {
  const id=kvId(); if(!id) return;
  const pass=sessionStorage.getItem('vc:kvPass');
  if(!pass){alert('Session expired \u2014 please re-enter your passphrase to sync.'); renderProfileSync(); return;}
  const st=statusElId?document.getElementById(statusElId):document.getElementById('kvSyncStatus');
  if(!navigator.onLine){
    _dbQueuePush();
    if(st) st.textContent='\uD83D\uDCF5 Offline \u2014 push queued, will retry when back online.';
    return;
  }
  if(st) st.textContent='Encrypting\u2026';
  try {
    const payload=await _encrypt(serialise(), pass);
    const r=await fetch(GORDY_SYNC_URL+id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:payload});
    if(r.status===429){if(st) st.textContent='\u26A0 Rate limited \u2014 wait 30s and try again.'; return;}
    if(!r.ok){if(st) st.textContent='\u26A0 Push failed ('+r.status+')'; _dbQueuePush(); return;}
    const now=Date.now();
    localStorage.setItem('vc:kvLastSyncTs', String(now));
    localStorage.setItem('vc:kvLastSync', new Date(now).toLocaleTimeString());
    localStorage.removeItem('vc:kvPendingPush');
    if(st) st.textContent='\u2713 Synced: '+new Date(now).toLocaleTimeString();
  } catch(e){
    _dbQueuePush();
    if(st) st.textContent='\u26A0 Network error \u2014 push queued.';
  }
}
*/

// Push encrypted data to Worker D1
async function dbPush(statusElId) {
  const id=kvId(); if(!id) return;
  const pass=sessionStorage.getItem('vc:kvPass');
  if(!pass){alert('Session expired \u2014 please re-enter your passphrase to sync.'); renderProfileSync(); return;}
  const st=statusElId?document.getElementById(statusElId):document.getElementById('kvSyncStatus');
  if(!navigator.onLine){
    _dbQueuePush();
    if(st) st.textContent='\uD83D\uDCF5 Offline \u2014 push queued, will retry when back online.';
    return;
  }
  if(st) st.textContent='Encrypting\u2026';
  try {
    const blob=await _encrypt(serialise(), pass);
    const currentVersion=parseInt(sessionStorage.getItem('gordy:version')||'0');
    const body=JSON.stringify({blob, blob_recovery:null, version:currentVersion+1});
    const r=await fetch(GORDY_SYNC_URL+'push/'+id, {method:'PUT', headers:{'Content-Type':'application/json'}, body});
    if(r.status===409){if(st) st.textContent='Out of sync \u2014 pull latest before pushing.'; return;}
    if(r.status===429){if(st) st.textContent='Daily push limit reached. Try again tomorrow.'; return;}
    if(r.status===423){const j=await r.json().catch(()=>({})); if(st) st.textContent=_fmtLockout(j.locked_until); return;}
    if(!r.ok){if(st) st.textContent='\u26A0 Push failed ('+r.status+')'; _dbQueuePush(); return;}
    const res=await r.json();
    sessionStorage.setItem('gordy:version', String(res.version));
    const now=Date.now();
    localStorage.setItem('vc:kvLastSyncTs', String(now));
    localStorage.setItem('vc:kvLastSync', new Date(now).toLocaleTimeString());
    localStorage.removeItem('vc:kvPendingPush');
    // Session persistence -- hooks wired by Session C via window._getActiveRound / window._getActiveRange
    const ar=window._getActiveRound?.(); if(ar!=null) localStorage.setItem('gordy:activeRound', JSON.stringify(ar));
    const ag=window._getActiveRange?.(); if(ag!=null) localStorage.setItem('gordy:activeRange', JSON.stringify(ag));
    if(st) st.textContent='\u2713 Synced: '+new Date(now).toLocaleTimeString();
  } catch(e){
    _dbQueuePush();
    if(st) st.textContent='\u26A0 Network error \u2014 push queued.';
  }
}

/* -- OLD kvPull (KV era) -- commented out, not deleted
async function kvPull(statusElId) {
  const id=kvId(); if(!id) return;
  const pass=sessionStorage.getItem('vc:kvPass');
  if(!pass){alert('Session expired \u2014 please re-enter your passphrase to sync.'); renderProfileSync(); return;}
  const st=statusElId?document.getElementById(statusElId):document.getElementById('kvSyncStatus');
  if(st) st.textContent='Fetching\u2026';
  try {
    const r=await fetch(GORDY_SYNC_URL+id);
    if(r.status===404){if(st) st.textContent='\u26A0 No data found for this ID.'; return;}
    if(!r.ok){if(st) st.textContent='\u26A0 Pull failed ('+r.status+')'; return;}
    const envelope=await r.text();
    if(st) st.textContent='Decrypting\u2026';
    let plaintext;
    try { plaintext=await _decrypt(envelope, pass); }
    catch { if(st) st.textContent='\u26A0 Wrong passphrase or corrupted data.'; return; }
    processDataText(plaintext);
    const ts=new Date().toLocaleTimeString();
    localStorage.setItem('vc:kvLastSync', ts);
    if(st) st.textContent='\u2713 Loaded: '+ts;
  } catch(e){if(st) st.textContent='\u26A0 Pull error: '+e.message;}
}
*/

// Pull and decrypt data from Worker D1
async function dbPull(statusElId) {
  const id=kvId(); if(!id) return;
  const pass=sessionStorage.getItem('vc:kvPass');
  if(!pass){alert('Session expired \u2014 please re-enter your passphrase to sync.'); renderProfileSync(); return;}
  const st=statusElId?document.getElementById(statusElId):document.getElementById('kvSyncStatus');
  if(st) st.textContent='Fetching\u2026';
  try {
    const r=await fetch(GORDY_SYNC_URL+'pull/'+id);
    if(r.status===404){if(st) st.textContent='\u26A0 No data found for this ID.'; return;}
    if(r.status===423){const j=await r.json().catch(()=>({})); if(st) st.textContent=_fmtLockout(j.locked_until); return;}
    if(!r.ok){if(st) st.textContent='\u26A0 Pull failed ('+r.status+')'; return;}
    const res=await r.json();
    if(st) st.textContent='Decrypting\u2026';
    let plaintext;
    try { plaintext=await _decrypt(res.blob, pass); }
    catch {
      const lu=await _reportFailure(id);
      if(st) st.textContent=lu?_fmtLockout(lu):'\u26A0 Wrong passphrase or corrupted data.';
      return;
    }
    await _reportSuccess(id);
    sessionStorage.setItem('gordy:version', String(res.version));
    processDataText(plaintext);
    const ts=new Date().toLocaleTimeString();
    localStorage.setItem('vc:kvLastSync', ts);
    if(st) st.textContent='\u2713 Loaded: '+ts;
  } catch(e){if(st) st.textContent='\u26A0 Pull error: '+e.message;}
}

// Banner load -- pull if connected, else prompt
async function bannerLoadGist() {
  if(!kvMode()){
    alert('No sync profile connected.\n\nSet up a sync profile in the Profile tab, or import your data file manually.');
    return;
  }
  await dbPull('kvSyncStatus');
  const hasData=bag.length||courses.length||rounds.length||history.length;
  if(hasData) document.getElementById('uploadBanner').style.display='none';
}

// Auto-push after every save -- throttled to 1 min minimum between auto-pushes
// Manual push (dbPush called directly) always bypasses this
async function syncSave() {
  if(!kvMode()) return;
  if(!sessionStorage.getItem('vc:kvPass')) return;
  if(Date.now()-lastAutoPushTime<60000) return; // throttle: skip silently if under 1 min
  await dbPush('kvSyncStatus');
  lastAutoPushTime=Date.now();
}

// -- Offline resilience
function _fmtAgo(tsMs) {
  if(!tsMs) return '';
  const s=Math.floor((Date.now()-parseInt(tsMs))/1000);
  if(s<60)   return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

function _dbQueuePush() { localStorage.setItem('vc:kvPendingPush','1'); }

async function _dbRetryPending() {
  if(!localStorage.getItem('vc:kvPendingPush')) return;
  if(!kvMode()||!sessionStorage.getItem('vc:kvPass')) return;
  localStorage.removeItem('vc:kvPendingPush');
  await dbPush('kvSyncStatus');
}

window.addEventListener('online', _dbRetryPending);

// Refresh "X ago" text every 60s without re-rendering the full card
setInterval(()=>{
  const el=document.getElementById('kvSyncAgo');
  if(el) el.textContent=_fmtAgo(localStorage.getItem('vc:kvLastSyncTs'));
}, 60000);

// -- Session persistence helpers
// type: 'round' | 'range'
function clearActiveSession(type) {
  if(type==='round')      localStorage.removeItem('gordy:activeRound');
  else if(type==='range') localStorage.removeItem('gordy:activeRange');
}

// Returns { type, state } for the first active session found, or null
function rehydrateActiveSession() {
  const r=localStorage.getItem('gordy:activeRound');
  const g=localStorage.getItem('gordy:activeRange');
  if(r){ try{ return {type:'round', state:JSON.parse(r)}; } catch {} }
  if(g){ try{ return {type:'range', state:JSON.parse(g)}; } catch {} }
  return null;
}

// -- Restore flow
// Returns array of { id, version, written_at }
async function dbFetchHistory(syncId) {
  const r=await fetch(GORDY_SYNC_URL+'history/'+syncId);
  if(!r.ok) throw new Error('History fetch failed ('+r.status+')');
  return r.json();
}

// Fetches, decrypts, and loads a specific history version into app state
async function dbRestoreVersion(syncId, version, passphrase) {
  const r=await fetch(GORDY_SYNC_URL+'history/'+syncId+'/'+version);
  if(!r.ok) throw new Error('Restore fetch failed ('+r.status+')');
  const {blob}=await r.json();
  let plaintext;
  try { plaintext=await _decrypt(blob, passphrase); }
  catch {
    const lu=await _reportFailure(syncId);
    throw new Error(lu?_fmtLockout(lu):'\u26A0 Wrong passphrase or corrupted data.');
  }
  processDataText(plaintext);
}

// -- Profile sync card setup/load flow
function startSyncSetup() {
  const card=document.getElementById('gistSettingsCard'); if(!card) return;
  const newId=_genSyncId();
  card.innerHTML=`
    <div class="card-title">Set Up Sync Profile</div>
    <div style="font-size:.68rem;color:var(--tx2);margin-bottom:12px;line-height:1.7">
      Your data is encrypted in your browser before it leaves your device. Your passphrase never touches the server.
    </div>
    <div style="background:var(--gr3);border:1px solid var(--gr2);border-radius:6px;padding:10px;margin-bottom:12px">
      <div style="font-size:.6rem;color:var(--tx3);margin-bottom:2px">Your sync ID \u2014 write this down</div>
      <div style="font-size:.9rem;font-family:'DM Mono',monospace;color:var(--ac);letter-spacing:.08em">${newId}</div>
    </div>
    <div class="field" style="margin-bottom:8px">
      <div class="flbl">Choose a passphrase</div>
      <input id="kvPassA" type="password" placeholder="Something memorable\u2026" autocomplete="new-password">
    </div>
    <div class="field" style="margin-bottom:12px">
      <div class="flbl">Confirm passphrase</div>
      <input id="kvPassB" type="password" placeholder="Repeat passphrase\u2026" autocomplete="new-password">
    </div>
    <div id="kvSetupStatus" style="font-size:.62rem;color:var(--tx3);margin-bottom:8px;min-height:1em"></div>
    <div style="display:flex;gap:8px">
      <button class="btn gold" onclick="finishSyncSetup('${newId}')">Create profile</button>
      <button class="btn sec" onclick="renderProfileSync()">Cancel</button>
    </div>`;
}

async function finishSyncSetup(newId) {
  const a=document.getElementById('kvPassA')?.value;
  const b=document.getElementById('kvPassB')?.value;
  const st=document.getElementById('kvSetupStatus');
  if(!a){if(st) st.textContent='Enter a passphrase.'; return;}
  if(a!==b){if(st) st.textContent='Passphrases do not match.'; return;}
  if(a.length<4){if(st) st.textContent='Passphrase too short \u2014 use at least 4 characters.'; return;}
  if(st) st.textContent='Creating profile\u2026';
  sessionStorage.setItem('vc:kvPass', a);
  localStorage.setItem('vc:kvId', newId);
  await dbPush('kvSetupStatus');
  renderProfileSync();
}

function showSyncLoad() {
  const card=document.getElementById('gistSettingsCard'); if(!card) return;
  card.innerHTML=`
    <div class="card-title">Load Sync Profile</div>
    <div style="font-size:.68rem;color:var(--tx2);margin-bottom:12px;line-height:1.7">
      Enter your sync ID and passphrase to load your data on this device.
    </div>
    <div class="field" style="margin-bottom:8px">
      <div class="flbl">Sync ID</div>
      <input id="kvLoadId" type="text" placeholder="GRD-xxxxxx" autocomplete="off">
    </div>
    <div class="field" style="margin-bottom:12px">
      <div class="flbl">Passphrase</div>
      <input id="kvLoadPass" type="password" placeholder="Your passphrase\u2026" autocomplete="current-password">
    </div>
    <div id="kvLoadStatus" style="font-size:.62rem;color:var(--tx3);margin-bottom:8px;min-height:1em"></div>
    <div style="display:flex;gap:8px">
      <button class="btn" onclick="finishSyncLoad()">Load profile</button>
      <button class="btn sec" onclick="renderProfileSync()">Cancel</button>
    </div>`;
}

async function finishSyncLoad() {
  const id=(document.getElementById('kvLoadId')?.value||'').trim();
  const pass=document.getElementById('kvLoadPass')?.value;
  const st=document.getElementById('kvLoadStatus');
  if(!id.match(/^GRD-[a-z0-9]{6}$/i)){if(st) st.textContent='Invalid sync ID \u2014 format is GRD-xxxxxx (lowercase).'; return;}
  if(!pass){if(st) st.textContent='Enter your passphrase.'; return;}
  if(st) st.textContent='Connecting\u2026';
  sessionStorage.setItem('vc:kvPass', pass);
  localStorage.setItem('vc:kvId', id);
  await dbPull('kvLoadStatus');
  renderProfileSync();
}

function disconnectSync() {
  if(!confirm('Disconnect sync profile?\n\nYour local data is kept. Your encrypted backup stays in the cloud until you overwrite it.')) return;
  localStorage.removeItem('vc:kvId');
  localStorage.removeItem('vc:kvLastSync');
  sessionStorage.removeItem('vc:kvPass');
  renderProfileSync();
}

function renderProfileSync() {
  const card=document.getElementById('gistSettingsCard'); if(!card) return;
  const connected=kvMode();
  const ts=localStorage.getItem('vc:kvLastSync');
  const tsMs=localStorage.getItem('vc:kvLastSyncTs');
  const hasPass=!!sessionStorage.getItem('vc:kvPass');
  const offline=!navigator.onLine;
  const pending=!!localStorage.getItem('vc:kvPendingPush');
  card.innerHTML=`
    <div class="card-title">Data Sync</div>
    ${connected ? `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
        <div style="font-size:.68rem;color:var(--ac)">\u2713 Profile: <strong>${kvId()}</strong></div>
        ${offline ? `<span style="font-size:.58rem;background:var(--sand2);color:var(--gold);border:1px solid var(--sand);border-radius:3px;padding:1px 6px">\uD83D\uDCF5 Offline</span>` : ''}
        ${pending&&!offline ? `<span style="font-size:.58rem;background:var(--gr3);color:var(--ac2);border:1px solid var(--gr2);border-radius:3px;padding:1px 6px">\u23F3 Push pending</span>` : ''}
      </div>
      <div style="font-size:.62rem;color:var(--tx3);margin-bottom:${hasPass?'10px':'4px'}" id="kvSyncStatus">
      ${ts ? `\u2713 Synced: ${ts}${tsMs ? ` <span id="kvSyncAgo" style="color:var(--tx3);opacity:.7">(${_fmtAgo(tsMs)})</span>` : ''}` : 'Not synced this session'}
      </div>
      ${!hasPass ? `<div style="font-size:.62rem;color:var(--gold);margin-bottom:10px">\u26A0 Enter passphrase to enable push/pull this session</div>
        <div class="field" style="margin-bottom:8px">
          <div class="flbl">Passphrase</div>
          <input id="kvSessionPass" type="password" placeholder="Your passphrase\u2026" autocomplete="current-password">
        </div>
        <button class="btn" style="margin-bottom:10px" onclick="const p=document.getElementById('kvSessionPass')?.value;if(p){sessionStorage.setItem('vc:kvPass',p);renderProfileSync();}">Unlock</button>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="dbPush('kvSyncStatus')" ${!hasPass?'disabled':''}>\u2191 Push</button>
        <button class="btn sec" onclick="dbPull('kvSyncStatus')" ${!hasPass||offline?'disabled':''}>\u2193 Pull</button>
        <button class="btn sec" onclick="saveData()">\u2B07 Export backup</button>
        <button class="btn danger" onclick="disconnectSync()">Disconnect</button>
      </div>
    ` : `
      <div style="font-size:.68rem;color:var(--tx2);margin-bottom:12px;line-height:1.7">
        Set up a sync profile to access your data on any device. Your data is encrypted before it leaves this browser \u2014 your passphrase never touches the server.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn gold" onclick="startSyncSetup()">Set up sync profile</button>
        <button class="btn sec" onclick="showSyncLoad()">Load existing profile</button>
      </div>
    `}`;
}

// Alias for renderAll compatibility
function renderGistSettings() { renderProfileSync(); }

// Check master Gist for newer app version on load
async function checkAppUpdate() {
  try {
    const r = await fetch(MASTER_GIST_RAW + APP_LATEST_FILE, {cache:'no-store'});
    if(!r.ok) return;
    const html = await r.text();
    const m = html.match(/const APP_VERSION\s*=\s*'(\d+)'/);
    if(!m) return;
    const remote = parseInt(m[1]);
    if(remote <= parseInt(window.APP_VERSION)) return;
    const go = confirm(`A new version of Virtual Caddie is available (v${remote}).\n\nUpdate now? Your data will not be affected.`);
    if(!go) return;
    const blob = new Blob([html], {type:'text/html'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `golf-caddie-v${remote}.html`; a.click();
    URL.revokeObjectURL(url);
  } catch {}
}

async function signOutSync() {
  const id=kvId();
  const hasPass=!!sessionStorage.getItem('vc:kvPass');
  const choice=confirm(
    `Sign out of sync profile ${id}?\n\nChoose an option:\n  OK = Push to cloud first, then sign out\n  Cancel = I'll choose below`
  );
  if(choice) {
    if(!hasPass) {
      const p=prompt('Enter your passphrase to push before signing out:');
      if(!p) return;
      sessionStorage.setItem('vc:kvPass',p);
    }
    await dbPush(null);
    _doSignOut();
  } else {
    const dl=confirm('Download a local backup TXT first, then sign out?');
    if(!dl) return;
    saveData();
    setTimeout(_doSignOut, 800);
  }
}

function _doSignOut() {
  localStorage.removeItem('vc:kvId');
  localStorage.removeItem('vc:kvLastSync');
  localStorage.removeItem('vc:kvLastSyncTs');
  localStorage.removeItem('vc:kvPendingPush');
  sessionStorage.removeItem('vc:kvPass');
  renderProfileSync();
  closeProfileDropdown();
  renderDropdown();
  alert('Signed out of sync profile. Your data remains on this device.');
}

Object.assign(window, {
  kvId, kvMode,
  dbPush, dbPull,
  kvPush: dbPush, kvPull: dbPull, // backwards-compat aliases -- Session C removes these
  syncSave, bannerLoadGist,
  startSyncSetup, finishSyncSetup,
  showSyncLoad, finishSyncLoad, disconnectSync,
  renderProfileSync, renderGistSettings, checkAppUpdate,
  signOutSync,
  clearActiveSession, rehydrateActiveSession,
  dbFetchHistory, dbRestoreVersion
});
