/* ============================================================
   로그 서재 — app.js
   서재(IndexedDB) → epub.js 뷰어 → 형광펜/메모/북마크/검색/백업
   ============================================================ */
'use strict';

/* ---------- 짧은 도우미 ---------- */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = ts => { const d = new Date(ts || Date.now()); return `${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const safeName = t => String(t || '').replace(/[\\/:*?"<>|\n]/g, ' ').trim().slice(0, 40) || 'book';

/* ---------- 주요 엘리먼트 ---------- */
const scrLibrary = $('#scr-library'), scrReader = $('#scr-reader');
const libList = $('#lib-list'), libSub = $('#lib-sub');
const fileEpub = $('#file-epub'), fileJson = $('#file-json');
const viewerEl = $('#viewer'), chipHidden = $('#chip-hidden') || {};
const rdTop = $('#rd-top'), rdBottom = $('#rd-bottom'), rdTitle = $('#rd-title');
const rdChapter = $('#rd-chapter'), rdPage = $('#rd-page'), sliderEl = $('#rd-slider');
const btnBookmark = $('#btn-bookmark');
const selbarEl = $('#selbar');
const pnToc = $('#pn-toc'), tocList = $('#toc-list');
const pnSearch = $('#pn-search'), searchInput = $('#search-input'), searchStatus = $('#search-status'), searchList = $('#search-list');
const pnCollect = $('#pn-collect'), tabHlEl = $('#tab-hl'), tabBmEl = $('#tab-bm'), chipsEl = $('#collect-chips'), collectList = $('#collect-list');
const sheetRoot = $('#sheet-root');
const toastWrap = $('#toast-wrap');
const loadingEl = $('#loading'), loadingMsg = $('#loading-msg');

/* ---------- 상수 ---------- */
const HL_COLORS = { red: '#ff6b6b', orange: '#ffa94d', yellow: '#ffd43b', green: '#69db7c', blue: '#74c0fc', purple: '#c89bfa', under: '#ff5c8a' };
const STYLE_KEYS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'under'];
const STYLE_NAMES = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라', under: '밑줄' };
const COVERS = [['#8b6ff0', '#5a3fb8'], ['#f06f9a', '#b83f6a'], ['#f0a05f', '#c06a2e'], ['#5fc98a', '#2e9c5c'], ['#5fa8f0', '#2e6ac0'], ['#c98af0', '#8a4fc0']];
const I = {
  stack: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  slider: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 4h4M6 7l1 14h10l1-14M10 11v6m4-6v6"/></svg>'
};

/* ---------- 설정 ---------- */
const DEFAULT_SET = { 
  fontSize: 105, 
  theme: 'light', 
  flow: 'page', 
  hlVisible: true,
  fontFamily: 'ridi',    // 기본 폰트를 리디바탕으로 지정
  lineHeight: '1.8',     
  letterSpacing: '0px',  
  padding: '24px',       
  markdown: true         
};
let settings = { ...DEFAULT_SET };
try { settings = { ...DEFAULT_SET, ...(JSON.parse(localStorage.getItem('lsj-settings') || '{}')) }; } catch (e) { /* 무시 */ }
const saveSettings = () => { try { localStorage.setItem('lsj-settings', JSON.stringify(settings)); } catch (e) { /* 무시 */ } };

/* ---------- 앱 상태 ---------- */
let db = null;
let book = null, rendition = null;
let current = { id: null, rec: null };
let annos = [];                 // 현재 책의 형광펜/북마크
let bookState = { bookId: null };
let tocFlat = [];
let curLoc = null, curChapter = '';
let locReady = false;
let pendingSel = null, hasSel = false;
let collectTab = 'hl', collectFilter = 'all';
let barsOn = false, barsTimer = null;
let searchSeq = 0;

/* ---------- 오류를 화면에 살짝 띄우기 (디버깅용) ---------- */
let lastErrAt = 0;
function surfaceError(msg) {
  if (Date.now() - lastErrAt < 4000) return;
  lastErrAt = Date.now();
  toast('앗, 오류가 났어요: ' + (msg || '알 수 없음'));
}
window.addEventListener('error', e => surfaceError(e.message));
window.addEventListener('unhandledrejection', e => surfaceError(e.reason && e.reason.message));

/* ============================================================
   IndexedDB
   ============================================================ */
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('log-seojae', 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('annos')) {
        const s = d.createObjectStore('annos', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'bookId' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
const tx = (s, m) => db.transaction(s, m).objectStore(s);
const dbPut = (s, v) => new Promise((res, rej) => { const r = tx(s, 'readwrite').put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
const dbGet = (s, k) => new Promise((res, rej) => { const r = tx(s, 'readonly').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbDel = (s, k) => new Promise((res, rej) => { const r = tx(s, 'readwrite').delete(k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
const dbAll = (s, idx, key) => new Promise((res, rej) => {
  const o = tx(s, 'readonly');
  const src = idx ? o.index(idx) : o;
  const r = key !== undefined ? src.getAll(key) : src.getAll();
  r.onsuccess = () => res(r.result || []);
  r.onerror = () => rej(r.error);
});

/* ============================================================
   토스트 / 로딩
   ============================================================ */
function toast(msg, actLabel, actFn) {
  const el = document.createElement('div');
  el.className = 'toast';
  const g = document.createElement('div');
  g.className = 'grow';
  g.textContent = msg;
  el.appendChild(g);
  if (actLabel) {
    const b = document.createElement('button');
    b.textContent = actLabel;
    b.onclick = () => { el.remove(); if (actFn) actFn(); };
    el.appendChild(b);
  }
  toastWrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 3800);
}
function showLoading(msg) { loadingMsg.textContent = msg || '여는 중…'; loadingEl.hidden = false; }
function hideLoading() { loadingEl.hidden = true; }

/* ============================================================
   레이어(뒤로가기) 스택 — 안드로이드 뒤로가기 버튼 대응
   ============================================================ */
const layerStack = [];
function pushLayer(closeFn) {
  layerStack.push(closeFn);
  history.pushState({ lv: layerStack.length }, '');
}
window.addEventListener('popstate', e => {
  const depth = (e.state && e.state.lv) || 0;
  while (layerStack.length > depth) {
    const fn = layerStack.pop();
    try { fn(); } catch (err) { /* 무시 */ }
  }
});

/* ---------- 바텀시트 ---------- */
let sheetEl = null, dimEl = null;
function closeSheetVisual() {
  if (dimEl) dimEl.remove();
  if (sheetEl) sheetEl.remove();
  dimEl = sheetEl = null;
}
function openSheet(html, opts) {
  const replace = !!(opts && opts.replace);
  closeSheetVisual();
  dimEl = document.createElement('div');
  dimEl.className = 'dim';
  sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';
  sheetEl.innerHTML = '<div class="grip"></div>' + html;
  sheetRoot.appendChild(dimEl);
  sheetRoot.appendChild(sheetEl);
  dimEl.onclick = () => history.back();
  if (replace && layerStack.length) layerStack[layerStack.length - 1] = closeSheetVisual;
  else pushLayer(closeSheetVisual);
  return sheetEl;
}
function openPanel(el, opts) {
  const replace = !!(opts && opts.replace);
  el.hidden = false;
  const closer = () => { el.hidden = true; };
  if (replace && layerStack.length) layerStack[layerStack.length - 1] = closer;
  else pushLayer(closer);
}

/* ============================================================
   서재
   ============================================================ */
const hashIdx = t => { let h = 7; for (const c of String(t || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % COVERS.length; };

async function renderLibrary() {
  const [books, states] = await Promise.all([dbAll('books'), dbAll('state')]);
  const pctOf = {};
  states.forEach(s => { if (s.pct != null) pctOf[s.bookId] = s.pct; });
  books.sort((a, b) => (b.lastOpened || b.addedAt || 0) - (a.lastOpened || a.addedAt || 0));
  libSub.textContent = books.length ? `${books.length}권 · 긋고, 적고, 다시 읽기` : 'EPUB을 넣어두고, 밑줄 긋고, 다시 꺼내 읽는 곳';
  if (!books.length) {
    libList.innerHTML = '<div class="lib-empty"><div class="big">서재가 비어 있어요</div>아래 ‘EPUB 추가’ 버튼으로 로그 파일을 넣으면<br>여기에 한 권씩 쌓여요.</div>';
    return;
  }
  libList.innerHTML = books.map(b => {
    const pair = COVERS[hashIdx(b.title)];
    const ch = (b.title || '책').trim().charAt(0) || '책';
    const pct = pctOf[b.id];
    return `<div style="display:flex;align-items:center;gap:2px">
      <button class="book-row" data-open="${esc(b.id)}" style="flex:1;min-width:0">
        <span class="book-cover" style="background:linear-gradient(155deg,${pair[0]},${pair[1]})">${esc(ch)}</span>
        <span class="book-info">
          <span class="book-title" style="display:block">${esc(b.title)}</span>
          <span class="book-meta" style="display:block">${esc(b.author || '작자 미상')}${pct != null ? ' · ' + pct + '%' : ''}</span>
          ${pct != null ? `<span class="book-pct" style="display:block"><i style="width:${pct}%"></i></span>` : ''}
        </span>
      </button>
      <button class="ibtn" data-more="${esc(b.id)}" data-title="${esc(b.title)}"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="19" r="1.1"/></svg></button>
    </div>`;
  }).join('');
}

async function fileId(buf) {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  } catch (e) {
    const u = new Uint8Array(buf);
    let h1 = 0;
    for (let i = 0; i < u.length; i += 997) h1 = (h1 * 31 + u[i]) >>> 0;
    return 'f' + h1.toString(36) + '-' + buf.byteLength.toString(36);
  }
}

async function importBook(file) {
  showLoading('책을 서재에 넣는 중…');
  try {
    const buf = await file.arrayBuffer();
    const id = await fileId(buf);
    const dup = await dbGet('books', id);
    if (dup) { hideLoading(); toast(`『${dup.title}』은 이미 서재에 있어요`); return; }
    let title = file.name.replace(/\.epub$/i, ''), author = '';
    try {
      const tb = ePub(buf);
      const md = await tb.loaded.metadata;
      if (md && md.title) title = md.title;
      if (md && md.creator) author = md.creator;
      tb.destroy();
    } catch (e) { /* 메타데이터 없이 진행 */ }
    await dbPut('books', { id, title, author, addedAt: Date.now(), lastOpened: 0, size: buf.byteLength, data: buf });
    hideLoading();
    renderLibrary();
    toast(`『${title}』을 서재에 넣었어요`);
  } catch (e) {
    hideLoading();
    toast('EPUB을 읽지 못했어요: ' + ((e && e.message) || ''));
  }
}

async function deleteBook(id) {
  const list = await dbAll('annos', 'bookId', id);
  for (const a of list) await dbDel('annos', a.id);
  await dbDel('state', id);
  await dbDel('books', id);
  renderLibrary();
}

function openBookMenu(id, title) {
  const el = openSheet(`
    <div class="sheet-title">${esc(title)}</div>
    <button class="sheet-item" data-a="ex">${I.down}기록 내보내기 (JSON)</button>
    <button class="sheet-item warn" data-a="del">${I.trash}서재에서 삭제</button>`);
  el.onclick = e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'ex') { exportBook(id); history.back(); }
    else openDeleteConfirm(id, title);
  };
}
function openDeleteConfirm(id, title) {
  const el = openSheet(`
    <div class="sheet-title">서재에서 삭제</div>
    <div class="anno-quote">『${esc(title)}』과 그 안의 형광펜·메모·북마크가 모두 지워져요. 필요하면 먼저 기록을 내보내두세요.</div>
    <div class="sheet-btns"><button class="btn" data-a="no">취소</button><button class="btn warn" data-a="yes">삭제</button></div>`, { replace: true });
  el.onclick = async e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'yes') { await deleteBook(id); toast('서재에서 뺐어요'); }
    history.back();
  };
}

/* ============================================================
   JSON 내보내기 / 가져오기
   ============================================================ */
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
}
const packBook = (rec, list) => ({
  bookId: rec.id, title: rec.title, author: rec.author || '',
  annotations: list.filter(a => a.type === 'hl'),
  bookmarks: list.filter(a => a.type === 'bm')
});

async function exportBook(id) {
  const rec = (current.id === id && current.rec) ? current.rec : await dbGet('books', id);
  if (!rec) return;
  const list = current.id === id ? annos : await dbAll('annos', 'bookId', id);
  if (!list.length) { toast('내보낼 기록이 아직 없어요'); return; }
  download(`${safeName(rec.title)}-기록.json`, { app: '로그서재', version: 1, exportedAt: new Date().toISOString(), books: [packBook(rec, list)] });
  toast('JSON 파일로 저장했어요');
}
async function exportAll() {
  const books = await dbAll('books');
  const out = [];
  let n = 0;
  for (const rec of books) {
    const list = await dbAll('annos', 'bookId', rec.id);
    if (list.length) { out.push(packBook(rec, list)); n += list.length; }
  }
  if (!n) { toast('아직 백업할 기록이 없어요'); return; }
  download(`로그서재-백업-${new Date().toISOString().slice(0, 10)}.json`, { app: '로그서재', version: 1, exportedAt: new Date().toISOString(), books: out });
  toast(`기록 ${n}개를 백업했어요`);
}
async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const books = data.books || [];
    let n = 0;
    for (const b of books) {
      const rows = [...(b.annotations || []), ...(b.bookmarks || [])];
      for (const a of rows) {
        if (!a || !a.cfi || !a.id) continue;
        const bookId = String(a.bookId || b.bookId || '');
        if (!bookId) continue;
        const rec = {
          id: String(a.id), bookId,
          type: a.type === 'bm' ? 'bm' : 'hl',
          style: a.style || '', cfi: a.cfi, text: a.text || '',
          note: a.note || '', created: a.created || Date.now(), chapter: a.chapter || ''
        };
        await dbPut('annos', rec);
        n++;
      }
    }
    toast(n ? `기록 ${n}개를 가져왔어요` : '가져올 기록을 찾지 못했어요');
    if (current.id) {
      annos = await dbAll('annos', 'bookId', current.id);
      redrawHlAll();
      refreshCollect();
      if (curLoc) updateBookmarkBtn(curLoc);
    }
  } catch (e) {
    toast('JSON을 읽지 못했어요. 로그서재에서 내보낸 파일인지 확인해주세요.');
  }
}

/* ============================================================
   뷰어 열기 / 닫기
   ============================================================ */
async function openBook(id) {
  showLoading('책을 펼치는 중…');
  try {
    const rec = await dbGet('books', id);
    if (!rec) { hideLoading(); toast('책을 찾지 못했어요'); return; }
    current = { id, rec };
    scrLibrary.hidden = true;
    scrReader.hidden = false;
    pushLayer(closeReaderVisual);
    rdTitle.textContent = rec.title;
    scrReader.dataset.theme = settings.theme;
    annos = await dbAll('annos', 'bookId', id);
    bookState = (await dbGet('state', id)) || { bookId: id };
    locReady = false;
    sliderEl.disabled = true;
    sliderEl.value = 0;
    rdChapter.textContent = '';
    rdPage.textContent = '';
    chipHidden.hidden = settings.hlVisible;
    curLoc = null; curChapter = ''; tocFlat = [];
    book = ePub(rec.data);
    book.loaded.navigation.then(nav => {
      const walk = (items, d) => (items || []).forEach(it => {
        tocFlat.push({ href: it.href || '', base: (it.href || '').split('#')[0], label: (it.label || '').trim(), d });
        if (it.subitems && it.subitems.length) walk(it.subitems, d + 1);
      });
      walk(nav.toc, 0);
      if (curLoc) updateLocUI(curLoc);
    }).catch(() => {});
    setupRendition();
    await rendition.display(bookState.lastCfi || undefined);
    hideLoading();
    setBars(true);
    scheduleBarsHide();
    rec.lastOpened = Date.now();
    dbPut('books', rec).catch(() => {});
    ensureLocations();
  } catch (e) {
    hideLoading();
    console.error(e);
    toast('책을 여는 데 실패했어요: ' + ((e && e.message) || ''));
  }
}

function closeReaderVisual() {
  searchSeq++;
  try { if (rendition) rendition.destroy(); } catch (e) { /* 무시 */ }
  try { if (book) book.destroy(); } catch (e) { /* 무시 */ }
  rendition = null; book = null;
  curLoc = null; annos = []; tocFlat = []; pendingSel = null; hasSel = false;
  current = { id: null, rec: null };
  viewerEl.innerHTML = '';
  hideSelbar();
  scrReader.hidden = true;
  scrLibrary.hidden = false;
  renderLibrary();
}

function setupRendition() {
  const flow = settings.flow === 'scroll' ? 'scrolled-doc' : 'paginated';
  rendition = book.renderTo(viewerEl, { width: '100%', height: '100%', flow, spread: 'none', allowScriptedContent: false });
  
  const T = rendition.themes;
  T.register('light', { body: { background: '#faf6ee', color: '#2b2433' } });
  T.register('dark', { body: { background: '#16131c', color: '#d8d2e4' }, a: { color: '#a58bff' } });
  T.register('sepia', { body: { background: '#f3e8d2', color: '#463a26' } });
  T.select(settings.theme);

  if (settings.hlVisible) annos.filter(a => a.type === 'hl').forEach(drawAnno);
  rendition.on('relocated', onRelocated);
  rendition.on('selected', onSelected);
  rendition.on('touchstart', onTouchStart);
  rendition.on('touchend', onTouchEnd);

  // 책 내용이 아이프레임 내부에 로드될 때 스타일 및 마크다운 강제 가공
  rendition.hooks.content.register(contents => {
    const doc = contents.document;
    const head = doc.head;

    // 1. KoPub 바탕 외부 스타일시트 링크 강제 삽입
    if (!doc.getElementById('dns-kopub-link')) {
      const lnk = doc.createElement('link');
      lnk.id = 'dns-kopub-link';
      lnk.rel = 'stylesheet';
      lnk.href = 'https://cdn.jsdelivr.net/npm/font-kopub@1.0/kopubbatang.min.css';
      head.appendChild(lnk);
    }

    // 2. 고유 스타일 요소 생성 및 사용자 커스텀 설정 실시간 강제 주입
    let customStyle = doc.getElementById('dns-custom-inject');
    if (!customStyle) {
      customStyle = doc.createElement('style');
      customStyle.id = 'dns-custom-inject';
      head.appendChild(customStyle);
    }

    const fontTarget = settings.fontFamily === 'ridi' ? "'Ridibatang'" : "'KoPub Batang'";
    
    customStyle.innerHTML = `
      @font-face {
        font-family: 'Ridibatang';
        src: url('https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff') format('woff');
        font-weight: normal;
        font-display: swap;
      }
      body, p, span, div, li, a {
        font-family: ${fontTarget}, serif !important;
        font-size: ${settings.fontSize}% !important;
        line-height: ${settings.lineHeight} !important;
        letter-spacing: ${settings.letterSpacing} !important;
      }
      body {
        padding-left: ${settings.padding} !important;
        padding-right: ${settings.padding} !important;
      }
    `;

    // 3. 마크다운 변환 파싱 (중복 변환으로 인한 형광펜 깨짐 방지 장치 포함)
    if (settings.markdown && !doc.body.classList.contains('md-done')) {
      try {
        let html = doc.body.innerHTML;
        
        // #, ##, ### 등 모든 마크다운 제목 변환 (1개부터 6개까지 자동 대응)
        html = html.replace(/(^|>|&lt;br&gt;|&lt;p&gt;|<br>|<p>)\s*(#{1,6})\s+(.*?)(?=&lt;br&gt;|&lt;p&gt;|<br>|<p>|&lt;\/p&gt;|<\/p>|<|$)/g, (match, prefix, hashes, content) => {
          const level = hashes.length; // # 개수 (1~6)
          const sizes = { 1: '1.5em', 2: '1.35em', 3: '1.2em', 4: '1.1em', 5: '1em', 6: '0.9em' };
          return `${prefix}<h${level} style="font-size: ${sizes[level] || '1.2em'}; color: var(--accent); margin: 14px 0; font-weight: 700; line-height: 1.3 !important;">${content}</h${level}>`;
        });

        // --- 또는 *** 구분선 변환 (테마에 맞춰 자연스럽게 녹아드는 회색 선)
        html = html.replace(/(^|>|&lt;br&gt;|&lt;p&gt;|<br>|<p>)\s*(-{3,}|\*{3,})\s*(?=&lt;br&gt;|&lt;p&gt;|<br>|<p>|&lt;\/p&gt;|<\/p>|<|$)/g, '$1<hr style="border:none; height:1px; background:rgba(128,128,128,0.3); margin:20px 0 !important;">');

        // ** 볼드체 변환
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent); font-weight:700;">$1</strong>');
        html = html.replace(/__(.*?)__/g, '<strong style="color:var(--accent); font-weight:700;">$1</strong>');
        
        // * 또는 _ 이탤릭체 변환 (기울임 + 요청하신 #82847F 색상 반영)
        html = html.replace(/\*(.*?)\*/g, '<em style="font-style:italic; color:#82847F;">$1</em>');
        html = html.replace(/_(.*?)_/g, '<em style="font-style:italic; color:#82847F;">$1</em>');
        
        // > 인용구 변환
        html = html.replace(/(^|>|&lt;br&gt;|&lt;p&gt;|<br>|<p>)\s*&gt;\s*(.*?)(?=&lt;br&gt;|&lt;p&gt;|<br>|<p>|&lt;\/p&gt;|<\/p>|<|$)/g, '$1<blockquote style="border-left:3px solid #8b6ff0; padding-left:10px; margin:8px 0; color:rgba(128,128,128,0.7); font-style:normal;">$2</blockquote>');
        
        doc.body.innerHTML = html;
        doc.body.classList.add('md-done');
      } catch (e) { console.error(e); }
    }

    try {
      contents.document.addEventListener('selectionchange', () => {
        const s = contents.window.getSelection();
        hasSel = !!(s && !s.isCollapsed && s.toString().trim());
        if (!hasSel) hideSelbar();
      });
      contents.document.addEventListener('touchstart', onTouchStart, { passive: true });
      contents.document.addEventListener('touchend', onTouchEnd, { passive: true });
    } catch (e) { /* 무시 */ }
  });
}

function recreateRendition() {
  if (!book) return;
  const cfi = (curLoc && curLoc.start && curLoc.start.cfi) || bookState.lastCfi;
  try { if (rendition) rendition.destroy(); } catch (e) { /* 무시 */ }
  viewerEl.innerHTML = '';
  curLoc = null;
  setupRendition();
  rendition.display(cfi || undefined).catch(() => {});
}

/* ---------- 테마 / 위치 ---------- */
function applyReaderTheme() {
  scrReader.dataset.theme = settings.theme;
  if (rendition) {
    rendition.themes.select(settings.theme);
    redrawHlAll();
  }
}

function onRelocated(loc) {
  curLoc = loc;
  updateLocUI(loc);
  updateBookmarkBtn(loc);
  saveStateDebounced(loc);
}

const tocLabelByHref = href => {
  if (!href) return '';
  const h = String(href).split('#')[0];
  const f = tocFlat.find(t => t.base === h || h.endsWith(t.base) || (t.base && t.base.endsWith(h)));
  return f ? f.label : '';
};

function updateLocUI(loc) {
  if (!loc || !loc.start) return;
  curChapter = tocLabelByHref(loc.start.href);
  rdChapter.textContent = curChapter || (current.rec ? current.rec.title : '');
  const d = loc.start.displayed || {};
  let pageTxt = d.page && d.total ? `${d.page}/${d.total}` : '';
  if (locReady && book) {
    const p = book.locations.percentageFromCfi(loc.start.cfi);
    if (p != null && !isNaN(p)) {
      sliderEl.value = Math.round(p * 1000);
      pageTxt = `${Math.round(p * 100)}%` + (pageTxt ? ' · ' + pageTxt : '');
    }
  }
  rdPage.textContent = pageTxt;
}

let stTimer = null;
function saveStateDebounced(loc) {
  bookState.bookId = current.id;
  bookState.lastCfi = loc.start.cfi;
  if (locReady && book) {
    const p = book.locations.percentageFromCfi(loc.start.cfi);
    if (p != null && !isNaN(p)) bookState.pct = Math.round(p * 100);
  }
  clearTimeout(stTimer);
  stTimer = setTimeout(() => { dbPut('state', bookState).catch(() => {}); }, 600);
}

async function ensureLocations() {
  try {
    const myBook = book;
    if (bookState.locations) {
      book.locations.load(bookState.locations);
    } else {
      await book.ready;
      await book.locations.generate(600);
      if (book !== myBook) return;
      bookState.locations = book.locations.save();
      bookState.bookId = current.id;
      dbPut('state', bookState).catch(() => {});
    }
    if (book !== myBook) return;
    locReady = true;
    sliderEl.disabled = false;
    if (curLoc) updateLocUI(curLoc);
  } catch (e) { console.warn('locations 실패', e); }
}

/* ---------- 상/하단 바 ---------- */
function setBars(v) {
  barsOn = v;
  rdTop.classList.toggle('hide', !v);
  rdBottom.classList.toggle('hide', !v);
}
function toggleBars() { clearTimeout(barsTimer); setBars(!barsOn); }
function scheduleBarsHide() { clearTimeout(barsTimer); barsTimer = setTimeout(() => setBars(false), 2600); }

/* ============================================================
   형광펜 / 밑줄 / 메모
   ============================================================ */
function markStyles(styleKey) {
  if (styleKey === 'under') return { stroke: HL_COLORS.under, 'stroke-width': '2px', 'stroke-opacity': '0.9' };
  const dark = settings.theme === 'dark';
  return { fill: HL_COLORS[styleKey] || HL_COLORS.yellow, 'fill-opacity': dark ? '0.45' : '0.4', 'mix-blend-mode': dark ? 'normal' : 'multiply' };
}
function drawAnno(a) {
  if (!rendition) return;
  const type = a.style === 'under' ? 'underline' : 'highlight';
  try { rendition.annotations.add(type, a.cfi, {}, () => openAnnoSheet(a.id), 'lv-mark', markStyles(a.style)); } catch (e) { /* 무시 */ }
}
function undrawAnno(a) {
  if (!rendition) return;
  const type = a.style === 'under' ? 'underline' : 'highlight';
  try { rendition.annotations.remove(a.cfi, type); } catch (e) { /* 무시 */ }
}
function redrawHlAll() {
  if (!rendition) return;
  annos.filter(a => a.type === 'hl').forEach(undrawAnno);
  if (settings.hlVisible) annos.filter(a => a.type === 'hl').forEach(drawAnno);
}
function setHlVisible(v) {
  settings.hlVisible = v;
  saveSettings();
  chipHidden.hidden = v;
  if (rendition) annos.filter(a => a.type === 'hl').forEach(a => { if (v) drawAnno(a); else undrawAnno(a); });
  toast(v ? '형광펜을 다시 보여드려요' : '형광펜을 잠시 숨겼어요. 기록은 그대로 있어요.');
}

const cfiStart = cfi => {
  if (!cfi || cfi.indexOf(',') === -1) return cfi;
  const m = String(cfi).match(/^epubcfi\((.*)\)$/);
  if (!m) return cfi;
  const parts = m[1].split(',');
  if (parts.length < 2) return cfi;
  return `epubcfi(${parts[0] + parts[1]})`;
};

function onSelected(cfiRange, contents) {
  let text = '';
  try { const s = contents.window.getSelection(); text = s ? s.toString() : ''; } catch (e) { /* 무시 */ }
  if (!text.trim()) return;
  pendingSel = { cfi: cfiRange, text: text.trim().slice(0, 400), contents };
  showSelbar();
}
function showSelbar() { selbarEl.hidden = false; clearTimeout(barsTimer); setBars(false); }
function hideSelbar() { selbarEl.hidden = true; }
function clearSelection() {
  try { if (pendingSel && pendingSel.contents) pendingSel.contents.window.getSelection().removeAllRanges(); } catch (e) { /* 무시 */ }
  pendingSel = null;
  hasSel = false;
}

function addHighlight(styleKey) {
  if (!pendingSel || !current.id) return;
  const a = {
    id: uid(), bookId: current.id, type: 'hl', style: styleKey,
    cfi: pendingSel.cfi, text: pendingSel.text, note: '',
    created: Date.now(), chapter: curChapter || ''
  };
  annos.push(a);
  dbPut('annos', a).catch(() => {});
  if (settings.hlVisible) {
    drawAnno(a);
    toast(styleKey === 'under' ? '밑줄을 그었어요' : `${STYLE_NAMES[styleKey]} 형광펜을 칠했어요`, '메모 달기', () => openNoteSheet(a.id));
  } else {
    toast('숨기기 상태라 화면엔 안 보이지만, 잘 저장했어요', '형광펜 보이기', () => setHlVisible(true));
  }
  clearSelection();
  hideSelbar();
  refreshCollect();
}

function removeAnnoRecord(a) {
  if (a.type === 'hl' && settings.hlVisible) undrawAnno(a);
  annos = annos.filter(x => x.id !== a.id);
  dbDel('annos', a.id).catch(() => {});
  refreshCollect();
  if (a.type === 'bm' && curLoc) updateBookmarkBtn(curLoc);
}

function jumpToReader(cfi, flash) {
  if (!rendition) return;
  const delta = Math.max(0, layerStack.length - 1);
  rendition.display(cfiStart(cfi)).then(() => { if (flash) flashCfi(cfi); }).catch(() => {});
  if (delta > 0) history.go(-delta);
}
function flashCfi(cfi) {
  try {
    rendition.annotations.add('highlight', cfi, {}, null, 'lv-flash', { fill: '#ffd43b', 'fill-opacity': '0.62' });
    setTimeout(() => { try { rendition.annotations.remove(cfi, 'highlight'); } catch (e) { /* 무시 */ } }, 1600);
  } catch (e) { /* 무시 */ }
}

/* ---------- 형광펜 상세 시트 ---------- */
function openAnnoSheet(id) {
  const a = annos.find(x => x.id === id);
  if (!a) return;
  const pens = STYLE_KEYS.map(k => k === 'under'
    ? `<button class="pen-under ${a.style === 'under' ? 'sel-on' : ''}" data-k="under">밑줄</button>`
    : `<button class="pen ${a.style === k ? 'sel-on' : ''}" data-k="${k}" style="background:${HL_COLORS[k]}"></button>`).join('');
  const el = openSheet(`
    <div class="anno-quote">${esc(a.text || '(본문)')}</div>
    <div class="pen-row">${pens}</div>
    ${a.note ? `<div class="anno-note" style="margin:0 0 14px">${esc(a.note)}</div>` : ''}
    <div class="sheet-btns">
      <button class="btn" data-a="note">${a.note ? '메모 고치기' : '메모 쓰기'}</button>
      <button class="btn" data-a="go">본문으로</button>
      <button class="btn warn" data-a="del">지우기</button>
    </div>`);
  el.onclick = e => {
    const p = e.target.closest('[data-k]');
    if (p) {
      const k = p.dataset.k;
      if (k !== a.style) {
        if (settings.hlVisible) undrawAnno(a);
        a.style = k;
        dbPut('annos', a).catch(() => {});
        if (settings.hlVisible) drawAnno(a);
        el.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('sel-on', b.dataset.k === k));
        refreshCollect();
      }
      return;
    }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'note') openNoteSheet(a.id, true);
    else if (b.dataset.a === 'go') jumpToReader(a.cfi, true);
    else if (b.dataset.a === 'del') { removeAnnoRecord(a); toast('지웠어요'); history.back(); }
  };
}

/* ---------- 메모 시트 ---------- */
function openNoteSheet(id, replace) {
  const a = annos.find(x => x.id === id);
  if (!a) return;
  const el = openSheet(`
    <div class="sheet-title">메모</div>
    <div class="anno-quote">${esc(a.text || '')}</div>
    <textarea id="note-text" placeholder="이 문장에 남길 말">${esc(a.note || '')}</textarea>
    <div class="sheet-btns">
      ${a.note ? '<button class="btn warn" id="note-del">메모 지우기</button>' : ''}
      <button class="btn primary" id="note-save">저장</button>
    </div>`, { replace });
  setTimeout(() => { const t = el.querySelector('#note-text'); if (t && !a.note) t.focus(); }, 120);
  el.querySelector('#note-save').onclick = () => {
    a.note = el.querySelector('#note-text').value.trim();
    dbPut('annos', a).catch(() => {});
    refreshCollect();
    toast(a.note ? '메모를 남겼어요' : '메모를 비웠어요');
    history.back();
  };
  const delBtn = el.querySelector('#note-del');
  if (delBtn) delBtn.onclick = () => {
    a.note = '';
    dbPut('annos', a).catch(() => {});
    refreshCollect();
    toast('메모를 지웠어요');
    history.back();
  };
}

/* ============================================================
   북마크
   ============================================================ */
function updateBookmarkBtn(loc) {
  if (!loc || !loc.start) return;
  const cfi = loc.start.cfi;
  btnBookmark.classList.toggle('on', annos.some(a => a.type === 'bm' && a.cfi === cfi));
}
function toggleBookmark() {
  if (!curLoc || !current.id) return;
  const cfi = curLoc.start.cfi;
  const ex = annos.find(a => a.type === 'bm' && a.cfi === cfi);
  if (ex) { removeAnnoRecord(ex); toast('북마크를 뺐어요'); }
  else {
    const a = { id: uid(), bookId: current.id, type: 'bm', style: '', cfi, text: '', note: '', created: Date.now(), chapter: curChapter || '' };
    annos.push(a);
    dbPut('annos', a).catch(() => {});
    toast('이 자리에 북마크를 꽂았어요');
    refreshCollect();
  }
  updateBookmarkBtn(curLoc);
}

/* ============================================================
   터치: 탭 / 스와이프
   ============================================================ */
let tStart = null;
function onTouchStart(e) {
  if (e.__lvT) return;
  e.__lvT = 1;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  tStart = { x: t.screenX, y: t.screenY, time: Date.now(), selbar: !selbarEl.hidden };
}
function onTouchEnd(e) {
  if (e.__lvE) return;
  e.__lvE = 1;
  if (!tStart) return;
  const st = tStart;
  tStart = null;
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  const dx = t.screenX - st.x, dy = t.screenY - st.y, dt = Date.now() - st.time;
  if (hasSel || st.selbar || !selbarEl.hidden) return;
  const w = window.screen.width || window.innerWidth;
  if (settings.flow === 'page' && dt < 700 && Math.abs(dx) > 60 && Math.abs(dy) < 70) {
    if (dx < 0) rendition.next(); else rendition.prev();
    return;
  }
  if (dt < 350 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
    const fx = t.screenX / w;
    if (settings.flow === 'page' && fx < 0.24) rendition.prev();
    else if (settings.flow === 'page' && fx > 0.76) rendition.next();
    else toggleBars();
  }
}

/* ============================================================
   목차
   ============================================================ */
function openTocPanel() {
  openPanel(pnToc);
  const cur = curLoc && curLoc.start ? String(curLoc.start.href).split('#')[0] : '';
  tocList.innerHTML = tocFlat.length
    ? tocFlat.map((t, i) => `<button class="toc-item ${t.d ? 'lv1' : ''} ${t.base === cur ? 'now' : ''}" data-i="${i}">${esc(t.label || '(제목 없음)')}</button>`).join('')
    : '<div class="panel-empty">이 책엔 목차 정보가 없어요.</div>';
}

/* ============================================================
   단어 검색
   ============================================================ */
function openSearchPanel() {
  openPanel(pnSearch);
  setTimeout(() => searchInput.focus(), 100);
}
function findInSection(item, q) {
  const out = [];
  const doc = item.document;
  if (!doc || !doc.body) return out;
  const label = tocLabelByHref(item.href) || '';
  const lq = q.toLowerCase();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const txt = node.textContent || '';
    const lt = txt.toLowerCase();
    let pos = lt.indexOf(lq);
    while (pos > -1) {
      try {
        const range = doc.createRange();
        range.setStart(node, pos);
        range.setEnd(node, Math.min(pos + q.length, txt.length));
        const cfi = item.cfiFromRange(range);
        const s = Math.max(0, pos - 34), en = Math.min(txt.length, pos + q.length + 34);
        const html = (s > 0 ? '…' : '') + esc(txt.slice(s, pos)) + '<mark>' + esc(txt.slice(pos, pos + q.length)) + '</mark>' + esc(txt.slice(pos + q.length, en)) + (en < txt.length ? '…' : '');
        out.push({ cfi, label, html });
      } catch (err) { /* 무시 */ }
      if (out.length >= 40) return out;
      pos = lt.indexOf(lq, pos + Math.max(1, lq.length));
    }
  }
  return out;
}
async function runSearch() {
  const q = searchInput.value.trim();
  if (!q || !book) return;
  const my = ++searchSeq;
  searchList.innerHTML = '';
  searchStatus.textContent = '';
  searchInput.blur();
  let count = 0;
  const items = (book.spine && book.spine.spineItems) || [];
  for (let i = 0; i < items.length; i++) {
    if (my !== searchSeq) return;
    searchStatus.textContent = `${i + 1} / ${items.length}장 훑는 중…`;
    const item = items[i];
    let found = [];
    try {
      await item.load(book.load.bind(book));
      found = findInSection(item, q);
    } catch (e) { /* 무시 */ }
    try { item.unload(); } catch (e) { /* 무시 */ }
    if (my !== searchSeq) return;
    if (found.length) {
      count += found.length;
      searchList.insertAdjacentHTML('beforeend', found.map(r =>
        `<button class="result-item" data-cfi="${esc(r.cfi)}"><div class="result-ex">${r.html}</div><div class="result-ch">${esc(r.label)}</div></button>`
      ).join(''));
    }
    if (count >= 200) { searchStatus.textContent = '결과가 많아 200개까지만 보여드려요'; return; }
    await new Promise(r => setTimeout(r, 0));
  }
  searchStatus.textContent = count ? `결과 ${count}개` : '찾지 못했어요. 띄어쓰기를 바꿔 다시 검색해보세요.';
}

/* ============================================================
   모아보기
   ============================================================ */
const CHIP_DEFS = [
  { k: 'all', label: '전체' },
  { k: 'red', label: '빨강', dot: HL_COLORS.red },
  { k: 'orange', label: '주황', dot: HL_COLORS.orange },
  { k: 'yellow', label: '노랑', dot: HL_COLORS.yellow },
  { k: 'green', label: '초록', dot: HL_COLORS.green },
  { k: 'blue', label: '파랑', dot: HL_COLORS.blue },
  { k: 'purple', label: '보라', dot: HL_COLORS.purple },
  { k: 'under', label: '밑줄', dot: HL_COLORS.under },
  { k: 'noted', label: '메모만' }
];
function openCollectPanel(replace) {
  openPanel(pnCollect, { replace });
  collectTab = 'hl';
  collectFilter = 'all';
  renderCollect();
}
function refreshCollect() { if (!pnCollect.hidden) renderCollect(); }
function renderCollect() {
  tabHlEl.classList.toggle('on', collectTab === 'hl');
  tabBmEl.classList.toggle('on', collectTab === 'bm');
  chipsEl.hidden = collectTab !== 'hl';
  if (collectTab === 'hl') {
    chipsEl.innerHTML = CHIP_DEFS.map(c =>
      `<button class="chip ${collectFilter === c.k ? 'on' : ''}" data-k="${c.k}">${c.dot ? `<span class="dot" style="background:${c.dot}"></span>` : ''}${c.label}</button>`
    ).join('');
  }
  let items;
  if (collectTab === 'hl') {
    items = annos.filter(a => a.type === 'hl' && (collectFilter === 'all' || (collectFilter === 'noted' ? !!a.note : a.style === collectFilter)));
  } else {
    items = annos.filter(a => a.type === 'bm');
  }
  items = items.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
  if (!items.length) {
    collectList.innerHTML = collectTab === 'hl'
      ? '<div class="panel-empty">아직 여기에 모인 게 없어요.<br>본문을 길게 눌러 문장을 고르면 펜이 나타나요.</div>'
      : '<div class="panel-empty">북마크가 없어요.<br>뷰어 위쪽의 리본 버튼으로 지금 자리를 꽂아두세요.</div>';
    return;
  }
  collectList.innerHTML = items.map(a => {
    const stripColor = a.type === 'bm' ? 'var(--accent)' : (a.style === 'under' ? HL_COLORS.under : (HL_COLORS[a.style] || '#999'));
    const body = a.type === 'bm'
      ? `<div class="anno-ex">${esc(a.chapter || '표시해둔 자리')}</div><div class="anno-foot"><span class="grow">북마크 · ${fmtDate(a.created)}</span></div>`
      : `<div class="anno-ex">${esc(a.text)}</div>${a.note ? `<div class="anno-note">${esc(a.note)}</div>` : ''}<div class="anno-foot"><span class="grow">${esc(a.chapter || '')}${a.chapter ? ' · ' : ''}${fmtDate(a.created)}</span></div>`;
    const btns = a.type === 'bm'
      ? `<button class="mini" data-del="${a.id}">빼기</button>`
      : `<button class="mini" data-note="${a.id}">메모</button><button class="mini" data-del="${a.id}">지우기</button>`;
    return `<div class="anno-card">
      <button class="anno-main" data-go="${a.id}">
        <span class="anno-strip" style="background:${stripColor}"></span>
        <span class="anno-body">${body}</span>
      </button>
      <div class="anno-foot" style="margin-top:8px;justify-content:flex-end">${btns}</div>
    </div>`;
  }).join('');
}

/* ============================================================
   뷰어 메뉴 / 설정 시트
   ============================================================ */
function openMenuSheet() {
  const el = openSheet(`
    <button class="sheet-item" data-act="collect">${I.stack}형광펜 · 메모 모아보기</button>
    <button class="sheet-item" data-act="hl">${I.eye}${settings.hlVisible ? '형광펜 숨기기' : '형광펜 보이기'}</button>
    <button class="sheet-item" data-act="set">${I.slider}보기 설정</button>
    <button class="sheet-item" data-act="export">${I.down}이 책 기록 내보내기 (JSON)</button>`);
  el.onclick = e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'collect') { closeSheetVisual(); openCollectPanel(true); }
    else if (act === 'hl') { setHlVisible(!settings.hlVisible); history.back(); }
    else if (act === 'set') { openSettingsSheet(true); }
    else if (act === 'export') { exportBook(current.id); history.back(); }
  };
}

function openSettingsSheet(replace) {
  const el = openSheet(`
    <div class="sheet-title">보기 설정</div>
    <div class="set-row"><span class="set-label">글자 크기</span>
      <div class="stepper"><button data-fs="-5">−</button><span class="val" id="fs-val"></span><button data-fs="5">＋</button></div>
    </div>
    <div class="set-row"><span class="set-label">글꼴 변경</span>
      <div class="seg" id="seg-font"><button data-fn="ridi">리디바탕</button><button data-fn="kopub">KoPub바탕</button></div>
    </div>
    <div class="set-row"><span class="set-label">문단 폭 여백</span>
      <div class="seg" id="seg-pad"><button data-pd="16px">넓게</button><button data-pd="32px">보통</button><button data-pd="48px">좁게</button></div>
    </div>
    <div class="set-row"><span class="set-label">줄 간격 (행간)</span>
      <div class="seg" id="seg-lh"><button data-lh="1.5">좁게</button><button data-lh="1.9">보통</button><button data-lh="2.4">넓게</button></div>
    </div>
    <div class="set-row"><span class="set-label">글자 간격 (자간)</span>
      <div class="seg" id="seg-ls"><button data-ls="-0.5px">좁게</button><button data-ls="0px">보통</button><button data-ls="1px">넓게</button></div>
    </div>
    <div class="set-row"><span class="set-label">마크다운 서식</span>
      <div class="seg" id="seg-md"><button data-md="true">적용</button><button data-md="false">해제</button></div>
    </div>
    <div class="set-row"><span class="set-label">화면 테마</span>
      <div class="seg" id="seg-theme"><button data-t="light">밝게</button><button data-t="sepia">세피아</button><button data-t="dark">어둡게</button></div>
    </div>
    <div class="set-row"><span class="set-label">페이지 넘김</span>
      <div class="seg" id="seg-flow"><button data-f="page">페이지</button><button data-f="scroll">스크롤</button></div>
    </div>`, { replace });

  const sync = () => {
    el.querySelector('#fs-val').textContent = settings.fontSize + '%';
    el.querySelectorAll('#seg-font button').forEach(b => b.classList.toggle('on', b.dataset.fn === settings.fontFamily));
    el.querySelectorAll('#seg-pad button').forEach(b => b.classList.toggle('on', b.dataset.pd === settings.padding));
    el.querySelectorAll('#seg-lh button').forEach(b => b.classList.toggle('on', b.dataset.lh === settings.lineHeight));
    el.querySelectorAll('#seg-ls button').forEach(b => b.classList.toggle('on', b.dataset.ls === settings.letterSpacing));
    el.querySelectorAll('#seg-md button').forEach(b => b.classList.toggle('on', b.dataset.md === String(settings.markdown)));
    el.querySelectorAll('#seg-theme button').forEach(b => b.classList.toggle('on', b.dataset.t === settings.theme));
    el.querySelectorAll('#seg-flow button').forEach(b => b.classList.toggle('on', b.dataset.f === settings.flow));
  };
  sync();

  el.onclick = e => {
    const fs = e.target.closest('[data-fs]');
    const fn = e.target.closest('[data-fn]');
    const pd = e.target.closest('[data-pd]');
    const lh = e.target.closest('[data-lh]');
    const ls = e.target.closest('[data-ls]');
    const md = e.target.closest('[data-md]');
    const th = e.target.closest('[data-t]');
    const fl = e.target.closest('[data-f]');

    if (fs) {
      settings.fontSize = Math.min(180, Math.max(80, settings.fontSize + Number(fs.dataset.fs)));
      saveSettings(); recreateRendition();
    } else if (fn) {
      settings.fontFamily = fn.dataset.fn;
      saveSettings(); recreateRendition();
    } else if (pd) {
      settings.padding = pd.dataset.pd;
      saveSettings(); recreateRendition();
    } else if (lh) {
      settings.lineHeight = lh.dataset.lh;
      saveSettings(); recreateRendition();
    } else if (ls) {
      settings.letterSpacing = ls.dataset.ls;
      saveSettings(); recreateRendition();
    } else if (md) {
      settings.markdown = md.dataset.md === 'true';
      saveSettings(); recreateRendition();
    } else if (th && th.dataset.t !== settings.theme) {
      settings.theme = th.dataset.t;
      saveSettings(); applyReaderTheme();
    } else if (fl && fl.dataset.f !== settings.flow) {
      settings.flow = fl.dataset.f;
      saveSettings(); recreateRendition();
    } else return;
    sync();
  };
}

/* ============================================================
   이벤트 연결
   ============================================================ */
function bindStatic() {
  $('#btn-add-epub').onclick = () => fileEpub.click();
  fileEpub.onchange = () => { if (fileEpub.files[0]) importBook(fileEpub.files[0]); fileEpub.value = ''; };
  $('#btn-backup').onclick = exportAll;
  $('#btn-restore').onclick = () => fileJson.click();
  fileJson.onchange = () => { if (fileJson.files[0]) importJSON(fileJson.files[0]); fileJson.value = ''; };

  libList.onclick = e => {
    const more = e.target.closest('[data-more]');
    if (more) { openBookMenu(more.dataset.more, more.dataset.title || ''); return; }
    const open = e.target.closest('[data-open]');
    if (open) openBook(open.dataset.open);
  };

  $('#btn-back').onclick = () => history.back();
  $('#btn-search').onclick = openSearchPanel;
  $('#btn-toc').onclick = openTocPanel;
  btnBookmark.onclick = toggleBookmark;
  $('#btn-menu').onclick = openMenuSheet;
  chipHidden.onclick = () => setHlVisible(true);

  document.querySelectorAll('.pn-close').forEach(b => { b.onclick = () => history.back(); });

  sliderEl.addEventListener('change', () => {
    if (!locReady || !book || !rendition) return;
    const cfi = book.locations.cfiFromPercentage(sliderEl.value / 1000);
    if (cfi) rendition.display(cfi).catch(() => {});
  });

  selbarEl.querySelectorAll('[data-style]').forEach(b => { b.onclick = () => addHighlight(b.dataset.style); });
  $('#sel-close').onclick = () => { clearSelection(); hideSelbar(); };

  $('#search-go').onclick = runSearch;
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  searchList.onclick = e => {
    const b = e.target.closest('[data-cfi]');
    if (b) jumpToReader(b.dataset.cfi, true);
  };

  tocList.onclick = e => {
    const b = e.target.closest('[data-i]');
    if (!b || !rendition) return;
    const t = tocFlat[Number(b.dataset.i)];
    if (!t) return;
    rendition.display(t.href).catch(() => {});
    history.back();
  };

  tabHlEl.onclick = () => { collectTab = 'hl'; renderCollect(); };
  tabBmEl.onclick = () => { collectTab = 'bm'; renderCollect(); };
  chipsEl.onclick = e => {
    const c = e.target.closest('[data-k]');
    if (c) { collectFilter = c.dataset.k; renderCollect(); }
  };
  collectList.onclick = e => {
    const go = e.target.closest('[data-go]');
    const note = e.target.closest('[data-note]');
    const del = e.target.closest('[data-del]');
    if (note) { openNoteSheet(note.dataset.note); return; }
    if (del) {
      const a = annos.find(x => x.id === del.dataset.del);
      if (a) { removeAnnoRecord(a); toast('지웠어요'); }
      return;
    }
    if (go) {
      const a = annos.find(x => x.id === go.dataset.go);
      if (a) jumpToReader(a.cfi, a.type === 'hl' && !settings.hlVisible);
    }
  };
  $('#btn-export-book').onclick = () => { if (current.id) exportBook(current.id); };
}

/* ============================================================
   시작
   ============================================================ */
(async function boot() {
  try {
    db = await openDB();
  } catch (e) {
    toast('저장소를 열지 못했어요. 크롬 시크릿 모드에서는 동작하지 않을 수 있어요.');
    return;
  }
  history.replaceState({ lv: 0 }, '');
  bindStatic();
  renderLibrary();
  
  // 캐시 지옥 해방용 개발 세팅 (테스트 완료 후 완전히 완성되면 앞에 //를 지워주세요!)
  // if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
