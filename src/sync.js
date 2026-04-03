import { serialise, save, bag, courses, rounds, history } from './store.js';

const MASTER_GIST_RAW = 'https://gist.githubusercontent.com/abzabhi/e91a5f6d85e17ab75b1defaa5fc9dab9/raw/';
const APP_LATEST_FILE = 'golf-caddie-latest.html';

// -- Gordy Sync -- encrypted KV via Cloudflare Worker
const GORDY_SYNC_URL = 'https://gordy-sync.gordythevirtualcaddie.workers.dev/sync/';

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

// Push encrypted data to Worker KV
async function kvPush(statusElId) {
  const id=kvId(); if(!id) return;
  const pass=sessionStorage.getItem('vc:kvPass');
  if(!pass){alert('Session expired \u2014 please re-enter your passphrase to sync.'); renderProfileSync(); return;}
  const st=statusElId?document.getElementById(statusElId):document.getElementById('kvSyncStatus');
  if(!navigator.onLine){
    _kvQueuePush();
    if(st) st.textContent='\uD83D\uDCF5 Offline \u2014 push queued, will retry when back online.';
    return;
  }
  if(st) st.textContent='Encrypting\u2026';
  try {
    const payload=await _encrypt(serialise(), pass);
    const r=await fetch(GORDY_SYNC_URL+id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:payload});
    if(r.status===429){if(st) st.textContent='\u26A0 Rate limited \u2014 wait 30s and try again.'; return;}
    if(!r.ok){if(st) st.textContent='\u26A0 Push failed ('+r.status+')'; _kvQueuePush(); return;}
    const now=Date.now();
    localStorage.setItem('vc:kvLastSyncTs', String(now));
    localStorage.setItem('vc:kvLastSync', new Date(now).toLocaleTimeString());
    localStorage.removeItem('vc:kvPendingPush');
    if(st) st.textContent='\u2713 Synced: '+new Date(now).toLocaleTimeString();
  } catch(e){
    _kvQueuePush();
    if(st) st.textContent='\u26A0 Network error \u2014 push queued.';
  }
}

// Pull and decrypt data from Worker KV
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

// Banner load -- pull if connected, else prompt
async function bannerLoadGist() {
  if(!kvMode()){
    alert('No sync profile connected.\n\nSet up a sync profile in the Profile tab, or import your data file manually.');
    return;
  }
  await kvPull('kvSyncStatus');
  const hasData=bag.length||courses.length||rounds.length||history.length;
  if(hasData) document.getElementById('uploadBanner').style.display='none';
}

// Auto-push after every save when sync profile is connected and passphrase in session
async function syncSave() {
  if(!kvMode()) return;
  if(!sessionStorage.getItem('vc:kvPass')) return;
  await kvPush('kvSyncStatus');
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

function _kvQueuePush() { localStorage.setItem('vc:kvPendingPush','1'); }

async function _kvRetryPending() {
  if(!localStorage.getItem('vc:kvPendingPush')) return;
  if(!kvMode()||!sessionStorage.getItem('vc:kvPass')) return;
  localStorage.removeItem('vc:kvPendingPush');
  await kvPush('kvSyncStatus');
}

window.addEventListener('online', _kvRetryPending);

// Refresh "X ago" text every 60s without re-rendering the full card
setInterval(()=>{
  const el=document.getElementById('kvSyncAgo');
  if(el) el.textContent=_fmtAgo(localStorage.getItem('vc:kvLastSyncTs'));
}, 60000);

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
  await kvPush('kvSetupStatus');
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
  await kvPull('kvLoadStatus');
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
        <button class="btn" onclick="kvPush('kvSyncStatus')" ${!hasPass?'disabled':''}>\u2191 Push</button>
        <button class="btn sec" onclick="kvPull('kvSyncStatus')" ${!hasPass||offline?'disabled':''}>\u2193 Pull</button>
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
    await kvPush(null);
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
  kvId, kvMode, kvPush, kvPull, syncSave,
  bannerLoadGist, startSyncSetup, finishSyncSetup,
  showSyncLoad, finishSyncLoad, disconnectSync,
  renderProfileSync, renderGistSettings, checkAppUpdate,
  signOutSync
});
