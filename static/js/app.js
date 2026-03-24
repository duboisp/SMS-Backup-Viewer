const PAGE_SIZE=200;
let STATE={
  view:'upload', sessionId:null, data:null,
  activeConv:null, searchQuery:'', msgSearch:'',
  sortOrder:'newest', callFilter:'all',
  convSort:'date_desc',
  msgPage:1, callPage:1, _cachedMessages:[],
  showGallery:false, mediaFilter:'all', mediaPage:1, mediaGrouped:false,
  _mediaItems:[], _mediaTotal:0,
  lightboxIdx:null, convMediaView:false,
  _lightboxItem:null,
  _searchMatchCount:0, _searchActiveIdx:0,
  uiScale:100,
};

// === THEME SYSTEM ===
function getPreferredTheme(){
  const stored=localStorage.getItem('sms-viewer-theme');
  if(stored==='light'||stored==='dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  localStorage.setItem('sms-viewer-theme',theme);
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')||'dark';
  applyTheme(cur==='dark'?'light':'dark');
  // Update toggle icons
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.innerHTML=themeToggleIcon();
  });
}
function themeToggleIcon(){
  const isDark=(document.documentElement.getAttribute('data-theme')||'dark')==='dark';
  if(isDark) return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
}
function initTheme(){
  applyTheme(getPreferredTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change',e=>{
    if(!localStorage.getItem('sms-viewer-theme')){
      applyTheme(e.matches?'light':'dark');
    }
  });
}
initTheme();

// Scroll position cache
let _scrollPositions = { convList: 0, chatMessages: 0 };

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
function avatarColor(n){let h=0;for(let i=0;i<n.length;i++)h=n.charCodeAt(i)+((h<<5)-h);return`hsl(${Math.abs(h)%360},55%,45%)`;}
function avatarSvg(size){const s=size||38;const p=Math.round(s*0.3);return`<svg width="${p}" height="${p}" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;}
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
function highlight(t,q){if(!q)return esc(t);return esc(t).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'gi'),'<mark>$1</mark>');}
function fmtSize(b){return b>1e9?(b/1e9).toFixed(1)+' GB':b>1e6?(b/1e6).toFixed(1)+' MB':b>1e3?(b/1e3).toFixed(1)+' KB':b+' B';}

function applyScale(pct){
  pct=Math.max(50,Math.min(200,pct));
  STATE.uiScale=pct;
  document.documentElement.style.zoom=(pct/100);
  const sl=$('#scaleLabel');if(sl)sl.textContent=pct+'%';
}

// === SAVE/RESTORE SCROLL ===
function saveScrollPositions(){
  const cl=$('.conv-list'); if(cl) _scrollPositions.convList=cl.scrollTop;
  const cm=$('#chatMessages'); if(cm) _scrollPositions.chatMessages=cm.scrollTop;
  const gw=$('.gallery-grid-wrap'); if(gw) _scrollPositions.galleryGrid=gw.scrollTop;
}
function restoreScrollPositions(){
  const cl=$('.conv-list'); if(cl) cl.scrollTop=_scrollPositions.convList||0;
  const cm=$('#chatMessages'); if(cm) cm.scrollTop=_scrollPositions.chatMessages||0;
  const gw=$('.gallery-grid-wrap'); if(gw) gw.scrollTop=_scrollPositions.galleryGrid||0;
}

// === SPLIT RENDERING ===
// Instead of rebuilding the full DOM, update only the changed section.

function render(){
  const root=document.getElementById('root');
  if(STATE.view==='upload'){root.innerHTML=renderUpload();bindUpload();}
  else if(STATE.view==='loading'){}
  else{root.innerHTML=renderApp();bindApp();restoreScrollPositions();}
  if(STATE.uiScale!==100) document.documentElement.style.zoom=(STATE.uiScale/100);
}

// Targeted updates that avoid full re-render
function updateSidebar(){
  saveScrollPositions();
  const el=$('.conv-list');
  if(!el)return render();
  const d=STATE.data, q=STATE.searchQuery.toLowerCase();
  let convs=d.conversations.filter(c=>!q||c.display_name.toLowerCase().includes(q)||c.address.includes(q));
  const sortFns={date_desc:(a,b)=>b.last_date_ts-a.last_date_ts,date_asc:(a,b)=>a.last_date_ts-b.last_date_ts,phone_asc:(a,b)=>a.address.localeCompare(b.address),phone_desc:(a,b)=>b.address.localeCompare(a.address)};
  if(sortFns[STATE.convSort]) convs.sort(sortFns[STATE.convSort]);
  el.innerHTML=convs.map(c=>renderConvItem(c)).join('');
  bindConvItems();
  restoreScrollPositions();
}

function updateChatArea(){
  saveScrollPositions();
  const el=$('.chat-area');
  if(!el)return render();
  el.innerHTML=STATE.activeConv?renderChatView():`<div class="placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><p>Select a conversation</p></div>`;
  bindChatArea();
  restoreScrollPositions();
}

function showLightbox(){
  let lb=document.getElementById('lightbox');
  if(STATE.lightboxIdx!==null){
    const html=renderLightbox();
    if(lb){lb.outerHTML=html;}else{document.body.insertAdjacentHTML('beforeend',html);}
    bindLightbox();
  }else{
    if(lb)lb.remove();
  }
}

function renderConvItem(c){
  return `<div class="conv-item ${STATE.activeConv===c.address?'active':''}" data-addr="${esc(c.address)}"><div class="conv-avatar" style="background:${avatarColor(c.display_name)}">${avatarSvg(38)}</div><div class="conv-info"><div class="conv-name">${esc(c.display_name)}</div><div class="conv-preview">${esc(c.address)}</div></div><div class="conv-meta"><div class="conv-date">${esc(((c.last_date||'').split(',')[0]||'').trim().slice(0,3)+', '+((c.last_date||'').split(',')[1]||'').trim()+', '+((c.last_date||'').split(',')[2]||'').trim().split(' ')[0])}</div><div class="conv-count">${c.count.toLocaleString()}${c.media_count?` · 📎${c.media_count.toLocaleString()}`:''}</div></div></div>`;
}

function renderUpload(){
  return `<div class="header"><div class="header-logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>SMS Backup Viewer</div><div class="header-actions"><button class="theme-toggle" id="themeToggle" title="Toggle theme">${themeToggleIcon()}</button></div></div>
  <div class="upload-zone"><div class="drop-area">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" style="margin-bottom:1rem"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>
    <h2>Open a Backup File</h2>
    <p id="uploadDesc">Enter the full path to your <strong>.xml</strong> or encrypted <strong>.zip</strong> backup file.</p>
    <div id="pathRow"><div class="path-input-row"><input class="path-input" id="pathInput" placeholder="/path/to/sms-backup.xml or .zip" autocomplete="off"/><button class="browse-btn" id="browseBtn" style="display:none;">Browse</button><button class="load-btn" id="loadBtn">Open</button></div></div>
    <div id="passwordRow" style="display:none;margin-top:0.6rem;">
      <div class="path-input-row"><input class="path-input" id="passwordInput" type="password" placeholder="ZIP password" autocomplete="off" style="flex:1;"/></div>
      <div style="font-size:0.68rem;color:var(--text-dim);margin-top:0.3rem;">Password is used for decryption only — never stored or sent anywhere</div>
    </div>
    <div class="size-note">Reads directly from disk — nothing is copied or uploaded</div>
    <div id="errorMsg"></div></div>
  <div class="privacy-note"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>100% local processing — no uploads, no copies, no data leaves your machine</div></div>`;
}

function bindUpload(){
  const tt=$('#themeToggle');if(tt)tt.onclick=toggleTheme;
  const pi=$('#pathInput'),lb=$('#loadBtn'),pw=$('#passwordInput'),pr=$('#passwordRow'),bb=$('#browseBtn');

  // Detect desktop mode — pywebview injects window.pywebview.api after page load,
  // so we poll until it appears (up to 3 seconds)
  function enableBrowse(){
    if(bb){
      bb.style.display='inline-block';
      bb.onclick=async()=>{
        try{
          const fp=await window.pywebview.api.browse_file();
          if(fp){
            pi.value=fp;
            pi.dispatchEvent(new Event('input'));
            if(!fp.toLowerCase().endsWith('.zip')){
              startParseJob(fp,'');
            }
          }
        }catch(e){console.error('Browse error:',e);}
      };
    }
    const desc=$('#uploadDesc');
    if(desc)desc.innerHTML='Select your <strong>.xml</strong> or encrypted <strong>.zip</strong> backup file.';
  }
  let pywebviewChecks=0;
  function checkPywebview(){
    if(window.pywebview&&window.pywebview.api){enableBrowse();}
    else if(pywebviewChecks++<30){setTimeout(checkPywebview,100);}
  }
  checkPywebview();

  // Show/hide password field based on .zip extension
  pi.addEventListener('input',()=>{
    const isZip=pi.value.trim().toLowerCase().endsWith('.zip');
    if(pr)pr.style.display=isZip?'block':'none';
  });
  lb.onclick=()=>{
    const p=pi.value.trim();
    if(!p)return;
    const password=pw?pw.value:'';
    startParseJob(p,password);
  };
  pi.addEventListener('keydown',e=>{if(e.key==='Enter')lb.click();});
  if(pw)pw.addEventListener('keydown',e=>{if(e.key==='Enter')lb.click();});
}
async function startParseJob(fp,password){
  showLoading();
  const body={filepath:fp};
  if(password)body.password=password;
  try{const r=await fetch('/start_parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');pollJob(d.job_id);}catch(e){STATE.view='upload';render();showError(e.message);}
}
function showLoading(){
  STATE.view='loading';
  document.getElementById('root').innerHTML=`<div class="header"><div class="header-logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>SMS Backup Viewer</div><div class="header-actions"><button class="theme-toggle" id="loadingThemeToggle" title="Toggle theme">${themeToggleIcon()}</button></div></div>
    <div class="progress-area">
      <div class="progress-spinner"></div>
      <div class="progress-text" id="progressText">Starting...</div>
      <div class="progress-bar-track" style="width:360px"><div class="progress-bar-fill" id="progressFill" style="width:0%"></div></div>
      <div id="progressDetail" style="font-size:0.75rem;color:var(--text-dim);font-family:var(--mono);text-align:center;margin-top:0.2rem;"></div>
    </div>`;
  const ltt=$('#loadingThemeToggle');if(ltt)ltt.onclick=toggleTheme;
}
function showError(msg){const el=$('#errorMsg');if(el)el.innerHTML='<div class="error-text">'+esc(msg)+'</div>';}

async function pollJob(jobId){
  let startTime=Date.now();
  const poll=async()=>{try{
    const r=await fetch('/job_status/'+jobId);const d=await r.json();
    const txt=$('#progressText'),fill=$('#progressFill'),detail=$('#progressDetail');

    if(d.status==='extracting'){
      const eb=d.extract_bytes_read||0;
      const et=d.extract_total||0;
      const pct=et>0?Math.min(99,Math.round((eb/et)*100)):0;
      if(fill)fill.style.width=pct+'%';
      if(txt)txt.textContent='Decrypting ZIP archive...';
      const elapsed=Math.round((Date.now()-startTime)/1000);
      const elapsedStr=elapsed>=60?Math.floor(elapsed/60)+'m '+elapsed%60+'s':elapsed+'s';
      let etaStr='';
      if(pct>2&&eb>0){
        const totalEstSec=Math.round(elapsed*(et/eb));
        const remaining=Math.max(0,totalEstSec-elapsed);
        etaStr=remaining>=60?'~'+Math.floor(remaining/60)+'m '+remaining%60+'s remaining':'~'+remaining+'s remaining';
      }
      if(detail)detail.textContent=[et>0?fmtSize(eb)+' / '+fmtSize(et):'',pct>0?pct+'%':'',elapsedStr,etaStr].filter(Boolean).join(' · ');
      setTimeout(poll,300);
    }else if(['parsing','starting'].includes(d.status)){
      const c=(d.progress||0).toLocaleString();
      const bytesRead=d.bytes_read||0;
      const fileSize=d.file_size||0;
      const st=d.stats||{};
      const mc=d.media_count||0;

      // Byte-based percentage (accurate progress)
      const pct=fileSize>0?Math.min(99,Math.round((bytesRead/fileSize)*100)):0;
      if(fill)fill.style.width=pct+'%';

      // Main status: breakdown of what's been found
      const parts=[];
      if(st.sms) parts.push(st.sms.toLocaleString()+' SMS');
      if(st.mms) parts.push(st.mms.toLocaleString()+' MMS');
      if(st.calls) parts.push(st.calls.toLocaleString()+' calls');
      if(mc) parts.push(mc.toLocaleString()+' media');
      const breakdown=parts.length?parts.join(' · '):'scanning...';
      if(txt)txt.textContent='Parsing — '+breakdown;

      // Detail line: bytes, percentage, elapsed time, ETA
      const sizeProgress=fileSize>0?fmtSize(bytesRead)+' / '+fmtSize(fileSize):'';
      const elapsed=Math.round((Date.now()-startTime)/1000);
      const elapsedStr=elapsed>=60?Math.floor(elapsed/60)+'m '+elapsed%60+'s':elapsed+'s';
      let etaStr='';
      if(pct>2&&bytesRead>0){
        const totalEstSec=Math.round(elapsed*(fileSize/bytesRead));
        const remaining=Math.max(0,totalEstSec-elapsed);
        etaStr=remaining>=60?'~'+Math.floor(remaining/60)+'m '+remaining%60+'s remaining':'~'+remaining+'s remaining';
      }
      if(detail) detail.textContent=[sizeProgress,pct+'%',elapsedStr,etaStr].filter(Boolean).join(' · ');

      setTimeout(poll,400);
    }else if(d.status==='sorting'){
      if(fill)fill.style.width='98%';
      if(txt)txt.textContent='Sorting '+(d.progress||0).toLocaleString()+' messages...';
      if(detail)detail.textContent='Building indexes';
      setTimeout(poll,400);
    }else if(d.status==='done'){
      if(fill)fill.style.width='100%';
      if(txt)txt.textContent='Loading UI...';
      if(detail)detail.textContent='';
      STATE.sessionId=d.session_id;
      const mr=await fetch('/session/'+d.session_id);STATE.data=await mr.json();
      STATE.view='loaded';STATE.activeConv=null;STATE.showGallery=false;STATE.msgPage=1;STATE.callPage=1;
      if(STATE.data.backup_type==='calls'){await loadCalls();}else{render();}
    }else if(d.status==='error'){STATE.view='upload';render();showError(d.error||'Failed');}
    else{setTimeout(poll,400);}
  }catch(e){STATE.view='upload';render();showError('Connection error: '+e.message);}};
  setTimeout(poll,300);
}

function renderApp(){
  const d=STATE.data,isMsg=d.backup_type==='messages';
  const ms=d.media_stats||{};
  const hasMedia=ms.total>0;
  return `<div class="header"><div class="header-logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>SMS Backup Viewer</div>
    <div class="header-stats">
      ${d.stats.sms?`<span><span class="stat-val">${d.stats.sms.toLocaleString()}</span> SMS</span>`:''}
      ${d.stats.mms?`<span><span class="stat-val">${d.stats.mms.toLocaleString()}</span> MMS</span>`:''}
      ${d.stats.calls?`<span><span class="stat-val">${d.stats.calls.toLocaleString()}</span> Calls</span>`:''}
      ${hasMedia?`<span><span class="stat-val">${ms.total.toLocaleString()}</span> Media</span>`:''}
    </div>
    <div class="header-actions">
      <div class="scale-control"><button class="scale-btn" id="scaleDown">−</button><span class="scale-label" id="scaleLabel" title="Click to reset">${STATE.uiScale}%</span><button class="scale-btn" id="scaleUp">+</button></div>
      ${hasMedia?`<button class="hdr-btn media-btn" id="mediaBtn">${STATE.showGallery?'← Messages':'Media Gallery ('+ms.total.toLocaleString()+')'}</button>`:''}
      <button class="hdr-btn accent" id="exportBtn">Export CSV</button>
      <button class="hdr-btn" id="newFileBtn">Open New File</button>
      <button class="theme-toggle" id="themeToggle" title="Toggle theme">${themeToggleIcon()}</button>
    </div></div>
    ${STATE.showGallery?renderGallery():(isMsg?renderMessagesLayout():renderCallsLayout())}`;
}

function renderMessagesLayout(){
  const d=STATE.data,q=STATE.searchQuery.toLowerCase();
  let convs=d.conversations.filter(c=>!q||c.display_name.toLowerCase().includes(q)||c.address.includes(q));

  // Sort conversations
  const sortFns={
    date_desc:(a,b)=>b.last_date_ts-a.last_date_ts,
    date_asc:(a,b)=>a.last_date_ts-b.last_date_ts,
    phone_asc:(a,b)=>a.address.localeCompare(b.address),
    phone_desc:(a,b)=>b.address.localeCompare(a.address),
  };
  if(sortFns[STATE.convSort]) convs.sort(sortFns[STATE.convSort]);

  return `<div class="app-layout">
    <div class="sidebar ${STATE.activeConv?'hidden-mobile':''}" id="sidebar">
      <div class="sidebar-header">
        <h3>Conversations (${convs.length.toLocaleString()})</h3>
        <input class="search-box" id="convSearch" placeholder="Search conversations…" value="${esc(STATE.searchQuery)}"/>
        <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
          <select class="sort-select" id="convSortSelect" style="margin-left:0;flex:1;min-width:0;">
            <option value="date_desc" ${STATE.convSort==='date_desc'?'selected':''}>Date (Newest)</option>
            <option value="date_asc" ${STATE.convSort==='date_asc'?'selected':''}>Date (Oldest)</option>
            <option value="phone_asc" ${STATE.convSort==='phone_asc'?'selected':''}>Phone (A-Z)</option>
            <option value="phone_desc" ${STATE.convSort==='phone_desc'?'selected':''}>Phone (Z-A)</option>
          </select>
        </div>
      </div>
      <div class="conv-list">${convs.map(c=>renderConvItem(c)).join('')}</div></div>
    <div class="chat-area">${STATE.activeConv?renderChatView():`<div class="placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><p>Select a conversation</p></div>`}</div></div>`;
}

function renderChatView(){
  const d=STATE.data,cached=STATE._cachedMessages||[];
  const conv=d.conversations.find(c=>c.address===STATE.activeConv);
  const name=conv?conv.display_name:STATE.activeConv,total=conv?conv.count:0;
  const mc=conv?conv.media_count||0:0;
  if(STATE.convMediaView) return renderConvMedia(conv, name, mc);

  let lastDate='',html='';
  let matchIdx=0;
  const isSearching=!!STATE.msgSearch;
  for(const m of cached){
    const day=m.date_display?(m.date_display.split(',').slice(0,3).join(',')):'';
    if(day!==lastDate){html+=`<div class="date-divider">${esc(day||'Unknown')}</div>`;lastDate=day;}
    const tc=m.type||'received';
    const el=['draft','failed','outbox','queued'].includes(tc)?`<div class="msg-type-label">${tc}</div>`:'';
    const bh=highlight(m.body||'',STATE.msgSearch);
    const mi=m.media_indices||[];
    const imgs=mi.map(idx=>`<img src="/session/${STATE.sessionId}/media/${idx}/stream" loading="lazy" data-media-idx="${idx}" class="chat-media-thumb"/>`).join('');
    const ib=imgs?`<div class="msg-images">${imgs}</div>`:'';
    const tm=m.date_display||'';
    // Mark search matches with data attribute for navigation
    const isMatch=isSearching&&(m.body||'').toLowerCase().includes(STATE.msgSearch.toLowerCase());
    const matchAttr=isMatch?` data-search-match="${matchIdx++}"`:'';
    const activeClass=isMatch&&(matchIdx-1)===STATE._searchActiveIdx?' search-active':'';
    html+=`<div class="msg-bubble ${tc}${activeClass}"${matchAttr}>${el}${bh}${ib}<div class="msg-time">${esc(tm)} · ${m.kind.toUpperCase()}</div></div>`;
  }
  if(isSearching) STATE._searchMatchCount=matchIdx;
  else STATE._searchMatchCount=0;

  const hasMore=cached.length<total&&!STATE.msgSearch;
  const searchNav=isSearching?`<div class="search-nav">${STATE._searchMatchCount>0?`<span class="search-count">${STATE._searchActiveIdx+1} / ${STATE._searchMatchCount}</span><button class="search-nav-btn" id="searchPrev" title="Previous match">▲</button><button class="search-nav-btn" id="searchNext" title="Next match">▼</button>`:`<span class="search-count no-results">No results</span>`}</div>`:'';
  return `<div class="chat-header"><button class="back-btn" id="backBtn">←</button><div class="conv-avatar" style="background:${avatarColor(name)};width:32px;height:32px">${avatarSvg(32)}</div><h2>${esc(name)}</h2><span class="badge">${cached.length.toLocaleString()} / ${total.toLocaleString()}</span>
      ${mc>0?`<button class="hdr-btn media-btn" id="convMediaBtn" style="margin-left:auto;font-size:0.72rem;padding:0.25rem 0.7rem;">Media (${mc.toLocaleString()})</button>`:''}</div>
    <div class="filter-bar"><input class="msg-search-box" id="msgSearch" placeholder="Search in conversation…" value="${esc(STATE.msgSearch)}" style="max-width:300px"/>${searchNav}<select class="sort-select" id="sortOrder"><option value="newest" ${STATE.sortOrder==='newest'?'selected':''}>Newest first</option><option value="oldest" ${STATE.sortOrder==='oldest'?'selected':''}>Oldest first</option></select></div>
    <div class="chat-messages" id="chatMessages">${html}${hasMore?`<div class="load-more-bar"><button class="load-more-btn" id="loadMoreBtn">Load more (${(total-cached.length).toLocaleString()} remaining)</button></div>`:''}</div>`;
}

function renderConvMedia(conv, name, totalMedia){
  const items=STATE._mediaItems||[];
  const total=STATE._mediaTotal||0;
  const ms=conv?conv.media_stats||{}:{};
  const catCounts={all:ms.total||0,image:ms.image||0,video:ms.video||0,audio:ms.audio||0};
  return `<div class="chat-header"><button class="back-btn" id="backBtn">←</button><div class="conv-avatar" style="background:${avatarColor(name)};width:32px;height:32px">${avatarSvg(32)}</div><h2>${esc(name)}</h2>
      <button class="hdr-btn" id="convMediaBackBtn" style="margin-left:auto;font-size:0.72rem;padding:0.25rem 0.7rem;">← Messages</button>
      <button class="hdr-btn accent" id="convExportZipBtn" style="font-size:0.72rem;padding:0.25rem 0.7rem;">Export ZIP</button></div>
    <div class="filter-bar">
      ${['all','image','video','audio'].map(f=>`<button class="filter-btn ${STATE.mediaFilter===f?'active':''}" data-cmfilter="${f}">${f[0].toUpperCase()+f.slice(1)} (${(catCounts[f]||0).toLocaleString()})</button>`).join('')}
      <select class="sort-select" id="convMediaSort"><option value="newest" ${STATE.sortOrder==='newest'?'selected':''}>Newest first</option><option value="oldest" ${STATE.sortOrder==='oldest'?'selected':''}>Oldest first</option></select>
    </div>
    <div class="gallery-grid-wrap">
      ${renderGalleryGrid(items, total, 'loadMoreConvMediaBtn')}
    </div>`;
}

function renderCallsLayout(){
  const d=STATE.data,allCalls=d.calls_page||[],total=d.stats.calls||0;
  const sorted=STATE.sortOrder==='newest'?[...allCalls].reverse():allCalls;
  const icons={incoming:'↙',outgoing:'↗',missed:'✕',voicemail:'✉',rejected:'⊘',refused:'⊘'};
  return `<div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
    <div class="filter-bar">${['all','incoming','outgoing','missed','voicemail'].map(f=>`<button class="filter-btn ${STATE.callFilter===f?'active':''}" data-filter="${f}">${f[0].toUpperCase()+f.slice(1)}</button>`).join('')}<select class="sort-select" id="sortOrder"><option value="newest" ${STATE.sortOrder==='newest'?'selected':''}>Newest first</option><option value="oldest" ${STATE.sortOrder==='oldest'?'selected':''}>Oldest first</option></select></div>
    <div class="call-list">${sorted.map(c=>`<div class="call-entry"><div class="call-icon ${c.type}">${icons[c.type]||'?'}</div><div class="call-details"><div class="call-name">${esc(c.contact_name||c.number)}</div>${c.contact_name?`<div class="call-number">${esc(c.number)}</div>`:''}</div><div class="call-meta"><div class="call-date">${esc(c.date_display)}</div><div class="call-dur">${esc(c.duration_display)}</div></div></div>`).join('')}
    ${allCalls.length<total?`<div class="load-more-bar"><button class="load-more-btn" id="loadMoreCallsBtn">Load more (${(total-allCalls.length).toLocaleString()} remaining)</button></div>`:''}</div></div>`;
}

// === MEDIA GALLERY (shared renderer) ===
function renderGalleryItem(m){
  const isImg=m.category==='image';
  const isVid=m.category==='video';
  const isAud=m.category==='audio';
  const thumb=isImg?`<img src="/session/${STATE.sessionId}/media/${m.idx}/stream" loading="lazy"/>`:`<div class="media-icon">${isVid?'🎬':isAud?'🎵':'📎'}</div>`;
  return `<div class="gallery-item" data-midx="${m.idx}">${thumb}<span class="media-type-badge ${m.category}">${m.category}</span><div class="media-overlay"><div class="media-label">${esc(m.name)}</div><div class="media-meta">${fmtSize(m.size)} · ${esc(((m.date_display||'').split(',')[0]||'').trim().slice(0,3)+', '+(m.date_display||'').split(',').slice(1).join(',').trim())}</div></div></div>`;
}

const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
function groupByMonth(items){
  const groups=[];
  let curKey='',curItems=[];
  for(const m of items){
    const d=new Date(m.date_ts);
    const key=d.getFullYear()+'-'+(d.getMonth()+1);
    if(key!==curKey){
      if(curItems.length)groups.push({key:curKey,label:curLabel,items:curItems});
      curKey=key;
      var curLabel=MONTH_NAMES[d.getMonth()]+' '+d.getFullYear();
      curItems=[m];
    }else{curItems.push(m);}
  }
  if(curItems.length)groups.push({key:curKey,label:curLabel,items:curItems});
  return groups;
}

function renderGalleryGrid(items, total, loadMoreId){
  if(items.length===0) return '<div class="placeholder"><p>No media found for this filter.</p></div>';
  let html='';
  if(STATE.mediaGrouped){
    // Sorted by date for grouping — if current sort isn't date-based, group by date anyway
    const sortedByDate=[...items].sort((a,b)=>b.date_ts-a.date_ts);
    const groups=groupByMonth(sortedByDate);
    for(const g of groups){
      html+=`<div class="media-group-header">${esc(g.label)}<span class="group-count">${g.items.length.toLocaleString()} items</span></div>`;
      html+=`<div class="gallery-grid">${g.items.map(renderGalleryItem).join('')}</div>`;
    }
  }else{
    html=`<div class="gallery-grid">${items.map(renderGalleryItem).join('')}</div>`;
  }
  if(items.length<total) html+=`<div class="load-more-bar" style="margin-top:1rem"><button class="load-more-btn" id="${loadMoreId}">Load more (${(total-items.length).toLocaleString()} remaining)</button></div>`;
  return html;
}

function renderGallery(){
  const ms=STATE.data.media_stats||{};
  const items=STATE._mediaItems||[];
  const total=STATE._mediaTotal||0;
  const catCounts={all:ms.total||0,image:ms.image||0,video:ms.video||0,audio:ms.audio||0};
  return `<div class="gallery-view">
    <div class="gallery-header"><h2>Media Gallery</h2>
      <div class="gallery-stats"><span><span class="gs-val">${(ms.image||0).toLocaleString()}</span> images</span><span><span class="gs-val">${(ms.video||0).toLocaleString()}</span> videos</span><span><span class="gs-val">${(ms.audio||0).toLocaleString()}</span> audio</span></div>
      <button class="hdr-btn accent" id="exportZipBtn" style="margin-left:auto;">Export All as ZIP</button></div>
    <div class="filter-bar">
      ${['all','image','video','audio'].map(f=>`<button class="filter-btn ${STATE.mediaFilter===f?'active':''}" data-mfilter="${f}">${f[0].toUpperCase()+f.slice(1)} (${(catCounts[f]||0).toLocaleString()})</button>`).join('')}
      <button class="group-toggle ${STATE.mediaGrouped?'active':''}" id="groupToggle">Group by month</button>
      <select class="sort-select" id="mediaSortOrder"><option value="newest" ${STATE.sortOrder==='newest'?'selected':''}>Date (Newest)</option><option value="oldest" ${STATE.sortOrder==='oldest'?'selected':''}>Date (Oldest)</option><option value="name_asc" ${STATE.sortOrder==='name_asc'?'selected':''}>Name (A-Z)</option><option value="name_desc" ${STATE.sortOrder==='name_desc'?'selected':''}>Name (Z-A)</option><option value="type_asc" ${STATE.sortOrder==='type_asc'?'selected':''}>Type</option><option value="size_desc" ${STATE.sortOrder==='size_desc'?'selected':''}>Size (Largest)</option><option value="size_asc" ${STATE.sortOrder==='size_asc'?'selected':''}>Size (Smallest)</option><option value="address_asc" ${STATE.sortOrder==='address_asc'?'selected':''}>Phone Number</option></select>
    </div>
    <div class="gallery-grid-wrap">
      ${renderGalleryGrid(items, total, 'loadMoreMediaBtn')}
    </div></div>`;
}

function renderLightbox(){
  const m=STATE._lightboxItem;
  if(!m)return '';
  const isImg=m.category==='image';
  const isVid=m.category==='video';
  const isAud=m.category==='audio';
  const streamUrl=STATE.sessionId?`/session/${STATE.sessionId}/media/${m.idx}/stream`:'';
  let content='';
  if(isImg) content=streamUrl?`<img src="${streamUrl}"/>`:'';
  else if(isVid) content=`<video src="${streamUrl}" controls autoplay style="max-width:90vw;max-height:80vh;border-radius:8px"></video>`;
  else if(isAud) content=`<div style="display:flex;flex-direction:column;align-items:center;gap:1.5rem;"><div style="width:120px;height:120px;border-radius:50%;background:var(--bg-surface);display:flex;align-items:center;justify-content:center;font-size:3rem;border:2px solid var(--border);">🎵</div><audio src="${streamUrl}" controls autoplay style="width:min(400px,80vw)"></audio></div>`;
  else content=`<div style="color:var(--text-muted);font-size:1.2rem;text-align:center"><div style="font-size:3rem;margin-bottom:1rem">📎</div>Preview not available for ${esc(m.content_type)}<br/><small>Use the download button below</small></div>`;
  if(!content) content=`<div style="color:var(--text-muted)">Preview not available</div>`;
  const dlUrl=STATE.sessionId?`/session/${STATE.sessionId}/media/${m.idx}/download`:'#';
  return `<div class="lightbox" id="lightbox">
    <button class="lightbox-close" id="lbClose">✕</button>
    ${content}
    <div class="lightbox-info"><div class="lb-name">${esc(m.name)}</div><div class="lb-meta">${fmtSize(m.size)} · ${esc(m.date_display)} · ${esc(m.contact_name||m.address)}</div>
    <a class="lightbox-dl" href="${dlUrl}" download="${esc(m.name)}">Download</a></div></div>`;
}

// === BINDING (split into sections) ===
function bindApp(){
  const tt=$('#themeToggle');if(tt)tt.onclick=toggleTheme;
  const nb=$('#newFileBtn');if(nb)nb.onclick=()=>{STATE.view='upload';STATE.data=null;STATE.sessionId=null;render();};
  const eb=$('#exportBtn');if(eb)eb.onclick=exportCSV;
  const mb=$('#mediaBtn');if(mb)mb.onclick=()=>{STATE.showGallery=!STATE.showGallery;STATE.convMediaView=false;if(STATE.showGallery){STATE.mediaFilter='all';STATE.mediaPage=1;STATE._mediaItems=[];loadMedia();}else{render();};};

  // Scale controls
  const su=$('#scaleUp'),sd=$('#scaleDown'),sl=$('#scaleLabel');
  if(su)su.onclick=()=>applyScale(STATE.uiScale+10);
  if(sd)sd.onclick=()=>applyScale(STATE.uiScale-10);
  if(sl)sl.onclick=()=>applyScale(100);

  // Conversation search with DEBOUNCE
  const cs=$('#convSearch');
  if(cs){let db=null;cs.oninput=()=>{STATE.searchQuery=cs.value;clearTimeout(db);db=setTimeout(()=>updateSidebar(),200);};}

  // Conversation sort
  const cvs=$('#convSortSelect');if(cvs)cvs.onchange=()=>{STATE.convSort=cvs.value;updateSidebar();};

  bindConvItems();
  bindChatArea();

  // Call filters
  $$('.filter-btn[data-filter]').forEach(b=>{b.onclick=()=>{STATE.callFilter=b.dataset.filter;STATE.callPage=1;loadCalls();};});
  const lmc=$('#loadMoreCallsBtn');if(lmc)lmc.onclick=()=>{STATE.callPage++;loadCalls(true);};

  // Global gallery bindings
  $$('.filter-btn[data-mfilter]').forEach(b=>{b.onclick=()=>{STATE.mediaFilter=b.dataset.mfilter;STATE.mediaPage=1;STATE._mediaItems=[];loadMedia();};});
  const mso=$('#mediaSortOrder');if(mso)mso.onchange=()=>{STATE.sortOrder=mso.value;STATE.mediaPage=1;STATE._mediaItems=[];loadMedia();};
  const gt=$('#groupToggle');if(gt)gt.onclick=()=>{STATE.mediaGrouped=!STATE.mediaGrouped;render();};
  const lmm=$('#loadMoreMediaBtn');if(lmm)lmm.onclick=()=>{STATE.mediaPage++;loadMedia(true);};
  const ezb=$('#exportZipBtn');if(ezb)ezb.onclick=exportMediaZip;

  // Gallery items
  $$('.gallery-item[data-midx]').forEach(el=>{el.onclick=()=>{const idx=parseInt(el.dataset.midx);STATE.lightboxIdx=idx;STATE._lightboxItem=STATE._mediaItems.find(x=>x.idx===idx)||null;showLightbox();};});
}

function bindConvItems(){
  $$('.conv-item').forEach(el=>{el.onclick=()=>{
    saveScrollPositions();
    STATE.activeConv=el.dataset.addr;STATE.msgSearch='';STATE.msgPage=1;STATE._cachedMessages=[];STATE.convMediaView=false;
    // Update active state in sidebar without full re-render
    $$('.conv-item').forEach(ci=>ci.classList.toggle('active',ci.dataset.addr===el.dataset.addr));
    updateChatArea();
    loadConvMsgs();
  };});
}

function bindChatArea(){
  const bb=$('#backBtn');if(bb)bb.onclick=()=>{if(STATE.convMediaView){STATE.convMediaView=false;updateChatArea();}else{STATE.activeConv=null;STATE.convMediaView=false;updateChatArea();}};
  const ms=$('#msgSearch');if(ms){let db=null;ms.oninput=()=>{STATE.msgSearch=ms.value;clearTimeout(db);db=setTimeout(()=>{STATE.msgPage=1;STATE._cachedMessages=[];STATE._searchActiveIdx=0;loadConvMsgs();},300);};}
  const so=$('#sortOrder');if(so)so.onchange=()=>{STATE.sortOrder=so.value;if(STATE.activeConv){STATE.msgPage=1;STATE._cachedMessages=[];loadConvMsgs();}else{STATE.callPage=1;loadCalls();}};
  const lm=$('#loadMoreBtn');if(lm)lm.onclick=()=>{STATE.msgPage++;loadConvMsgs(true);};

  // Search navigation prev/next
  const sp=$('#searchPrev');if(sp)sp.onclick=()=>{if(STATE._searchMatchCount>0){STATE._searchActiveIdx=(STATE._searchActiveIdx-1+STATE._searchMatchCount)%STATE._searchMatchCount;updateChatArea();scrollToActiveMatch();}};
  const sn=$('#searchNext');if(sn)sn.onclick=()=>{if(STATE._searchMatchCount>0){STATE._searchActiveIdx=(STATE._searchActiveIdx+1)%STATE._searchMatchCount;updateChatArea();scrollToActiveMatch();}};

  // Auto-scroll to first match after search results load
  if(STATE.msgSearch&&STATE._searchMatchCount>0) scrollToActiveMatch();

  const cmb=$('#convMediaBtn');if(cmb)cmb.onclick=()=>{STATE.convMediaView=true;STATE.mediaFilter='all';STATE.mediaPage=1;STATE._mediaItems=[];loadConvMedia();};
  const cmbb=$('#convMediaBackBtn');if(cmbb)cmbb.onclick=()=>{STATE.convMediaView=false;updateChatArea();};
  const cezb=$('#convExportZipBtn');if(cezb)cezb.onclick=()=>exportConvMediaZip();

  $$('.filter-btn[data-cmfilter]').forEach(b=>{b.onclick=()=>{STATE.mediaFilter=b.dataset.cmfilter;STATE.mediaPage=1;STATE._mediaItems=[];loadConvMedia();};});
  const cms=$('#convMediaSort');if(cms)cms.onchange=()=>{STATE.sortOrder=cms.value;STATE.mediaPage=1;STATE._mediaItems=[];loadConvMedia();};
  const lmcm=$('#loadMoreConvMediaBtn');if(lmcm)lmcm.onclick=()=>{STATE.mediaPage++;loadConvMedia(true);};

  $$('.gallery-item[data-midx]').forEach(el=>{el.onclick=()=>{const idx=parseInt(el.dataset.midx);STATE.lightboxIdx=idx;STATE._lightboxItem=STATE._mediaItems.find(x=>x.idx===idx)||null;showLightbox();};});

  // Inline chat media click → fetch metadata and open lightbox
  $$('.chat-media-thumb[data-media-idx]').forEach(el=>{el.onclick=(e)=>{
    e.stopPropagation();
    openMediaLightbox(parseInt(el.dataset.mediaIdx));
  };});
}

async function openMediaLightbox(idx){
  // Try to find in already-loaded gallery items first
  let item=STATE._mediaItems.find(x=>x.idx===idx);
  if(!item){
    // Fetch metadata from server
    try{
      const r=await fetch(`/session/${STATE.sessionId}/media/${idx}/info`);
      if(r.ok) item=await r.json();
    }catch(e){console.error(e);}
  }
  if(!item){
    // Minimal fallback — enough to show the image/video
    item={idx,category:'image',content_type:'image/jpeg',name:'media_'+idx,size:0,date_display:'',contact_name:'',address:''};
  }
  STATE.lightboxIdx=idx;
  STATE._lightboxItem=item;
  showLightbox();
}

function scrollToActiveMatch(){
  requestAnimationFrame(()=>{
    const el=document.querySelector(`.msg-bubble[data-search-match="${STATE._searchActiveIdx}"]`);
    if(el){
      el.scrollIntoView({behavior:'smooth',block:'center'});
    }
  });
}

function bindLightbox(){
  const lb=$('#lightbox');if(lb){lb.onclick=e=>{if(e.target===lb)closeLightbox();};}
  const lbc=$('#lbClose');if(lbc)lbc.onclick=closeLightbox;
  document.onkeydown=e=>{if(e.key==='Escape'&&STATE.lightboxIdx!==null)closeLightbox();};
}

function closeLightbox(){STATE.lightboxIdx=null;STATE._lightboxItem=null;showLightbox();document.onkeydown=null;}

// === DATA LOADING ===
async function loadConvMsgs(append){
  if(!STATE.sessionId||!STATE.activeConv)return;
  const p=new URLSearchParams({address:STATE.activeConv,page:STATE.msgPage,page_size:PAGE_SIZE,sort:STATE.sortOrder});
  if(STATE.msgSearch)p.set('search',STATE.msgSearch);
  try{
    const r=await fetch(`/session/${STATE.sessionId}/messages?${p}`);const d=await r.json();
    STATE._cachedMessages=append?[...STATE._cachedMessages,...d.messages]:d.messages;
    saveScrollPositions();
    updateChatArea();
  }catch(e){console.error(e);}
}
async function loadCalls(append){
  if(!STATE.sessionId)return;
  const p=new URLSearchParams({page:STATE.callPage,page_size:PAGE_SIZE,sort:STATE.sortOrder});
  if(STATE.callFilter!=='all')p.set('type',STATE.callFilter);
  try{const r=await fetch(`/session/${STATE.sessionId}/calls?${p}`);const d=await r.json();STATE.data.calls_page=append?[...(STATE.data.calls_page||[]),...d.calls]:d.calls;render();}catch(e){console.error(e);}
}
async function loadMedia(append){
  if(!STATE.sessionId)return;
  const p=new URLSearchParams({page:STATE.mediaPage,page_size:60,sort:STATE.sortOrder});
  if(STATE.mediaFilter!=='all')p.set('category',STATE.mediaFilter);
  try{const r=await fetch(`/session/${STATE.sessionId}/media?${p}`);const d=await r.json();STATE._mediaItems=append?[...STATE._mediaItems,...d.items]:d.items;STATE._mediaTotal=d.total;saveScrollPositions();render();}catch(e){console.error(e);}
}
async function loadConvMedia(append){
  if(!STATE.sessionId||!STATE.activeConv)return;
  const p=new URLSearchParams({page:STATE.mediaPage,page_size:60,sort:STATE.sortOrder,address:STATE.activeConv});
  if(STATE.mediaFilter!=='all')p.set('category',STATE.mediaFilter);
  try{const r=await fetch(`/session/${STATE.sessionId}/media?${p}`);const d=await r.json();STATE._mediaItems=append?[...STATE._mediaItems,...d.items]:d.items;STATE._mediaTotal=d.total;saveScrollPositions();updateChatArea();}catch(e){console.error(e);}
}

// === EXPORTS ===
async function startExportJob(url, body){
  try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');showExportToast(d.job_id,d.total);}catch(e){alert('Export error: '+e.message);}
}
async function exportMediaZip(){if(!STATE.sessionId)return;const body={};if(STATE.mediaFilter!=='all')body.category=STATE.mediaFilter;startExportJob(`/session/${STATE.sessionId}/export_media_zip`,body);}
async function exportConvMediaZip(){if(!STATE.sessionId||!STATE.activeConv)return;const body={address:STATE.activeConv};if(STATE.mediaFilter!=='all')body.category=STATE.mediaFilter;startExportJob(`/session/${STATE.sessionId}/export_media_zip`,body);}
async function exportCSV(){if(!STATE.sessionId)return;startExportJob(`/session/${STATE.sessionId}/export_csv`,{});}

function showExportToast(jobId, total){
  let container=document.getElementById('exportToasts');
  if(!container){container=document.createElement('div');container.id='exportToasts';container.className='export-toasts';document.body.appendChild(container);}
  const toast=document.createElement('div');toast.className='export-toast';toast.id='toast-'+jobId;
  toast.innerHTML=`<div class="toast-header"><div class="toast-icon"><div class="t-spinner"></div></div><div class="toast-title">Exporting...</div><button class="toast-close" data-action="minimize" title="Minimize">─</button></div><div class="toast-body"><div class="toast-detail">Preparing export</div><div class="toast-progress-track"><div class="toast-progress-fill" style="width:0%"></div></div><div class="toast-actions"><button class="toast-btn cancel" data-action="cancel">Cancel</button><span class="toast-pct"></span></div></div>`;
  container.appendChild(toast);
  const body=toast.querySelector('.toast-body'),titleEl=toast.querySelector('.toast-title'),iconEl=toast.querySelector('.toast-icon'),detailEl=toast.querySelector('.toast-detail'),fillEl=toast.querySelector('.toast-progress-fill'),actionsEl=toast.querySelector('.toast-actions'),pctEl=toast.querySelector('.toast-pct'),closeBtn=toast.querySelector('.toast-close');
  let minimized=false;
  closeBtn.onclick=()=>{if(minimized){body.style.display='';closeBtn.textContent='─';minimized=false;}else{body.style.display='none';closeBtn.textContent='+';minimized=true;}};
  const cancelBtn=toast.querySelector('[data-action="cancel"]');
  if(cancelBtn)cancelBtn.onclick=async()=>{cancelBtn.disabled=true;cancelBtn.textContent='Cancelling...';try{await fetch('/export_job/'+jobId+'/cancel',{method:'POST'});}catch(e){}};
  const poll=async()=>{
    if(!document.getElementById('toast-'+jobId))return;
    try{const r=await fetch('/export_job/'+jobId);const d=await r.json();
      if(d.status==='building'||d.status==='starting'){
        const pct=d.total>0?Math.round((d.progress/d.total)*100):0;fillEl.style.width=pct+'%';detailEl.textContent=d.progress.toLocaleString()+' / '+d.total.toLocaleString()+' items';pctEl.textContent=pct+'%';setTimeout(poll,300);
      }else if(d.status==='done'){
        toast.classList.add('done');fillEl.style.width='100%';fillEl.classList.add('done');titleEl.textContent='Saved to Downloads';iconEl.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';detailEl.textContent=d.filename+' — '+fmtSize(d.size);actionsEl.innerHTML=`<button class="toast-btn dismiss" data-action="dismiss">Dismiss</button>`;actionsEl.querySelector('[data-action="dismiss"]').onclick=()=>toast.remove();closeBtn.textContent='✕';closeBtn.onclick=()=>toast.remove();if(minimized){body.style.display='';minimized=false;}
      }else if(d.status==='cancelled'){
        toast.classList.add('cancelled');fillEl.style.width='100%';fillEl.classList.add('cancelled');titleEl.textContent='Cancelled';iconEl.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';detailEl.textContent='Stopped at '+d.progress.toLocaleString()+' / '+d.total.toLocaleString();actionsEl.innerHTML=`<button class="toast-btn dismiss" data-action="dismiss">Dismiss</button>`;actionsEl.querySelector('[data-action="dismiss"]').onclick=()=>toast.remove();closeBtn.textContent='✕';closeBtn.onclick=()=>toast.remove();if(minimized){body.style.display='';minimized=false;}
      }else if(d.status==='error'){
        toast.classList.add('error');fillEl.style.width='100%';fillEl.classList.add('error');titleEl.textContent='Export Failed';iconEl.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';detailEl.textContent=d.error||'Unknown error';actionsEl.innerHTML=`<button class="toast-btn dismiss" data-action="dismiss">Dismiss</button>`;actionsEl.querySelector('[data-action="dismiss"]').onclick=()=>toast.remove();closeBtn.textContent='✕';closeBtn.onclick=()=>toast.remove();if(minimized){body.style.display='';minimized=false;}
      }else{setTimeout(poll,300);}
    }catch(e){console.error(e);setTimeout(poll,1000);}
  };
  setTimeout(poll,200);
}

render();
