'use strict';
/*
 * 楽譜ビューア（ScorePDF風 PWA）
 * - PDFは端末内（IndexedDB）に保存するのでオフラインでも表示できる
 * - Googleドライブは iOS の「ファイル」ピッカー経由で選ぶ
 */

const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const range = n => Array.from({ length: n }, (_, i) => i);

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M7 4v16l13-8z"/></svg>',
};

/* ================= 設定 ================= */
const DEFAULT_SETTINGS = { spread: true, stepOne: false, anim: true, wake: true };
const settings = (() => {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('settings') || '{}')); }
  catch { return { ...DEFAULT_SETTINGS }; }
})();
function saveSettings() { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {} }

/* ================= IndexedDB ================= */
// scores: 楽譜のメタ情報 / files: PDF本体(ArrayBuffer) / annotations: 書き込み / setlists
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('score-viewer', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('scores', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('annotations');
        db.createObjectStore('setlists', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    all: s => tx(s, 'readonly', st => st.getAll()),
    get: (s, k) => tx(s, 'readonly', st => st.get(k)),
    put: (s, v, k) => tx(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
    delPrefix: (s, p) => tx(s, 'readwrite', st => st.delete(IDBKeyRange.bound(p, p + '￿'))),
  };
})();

/* ================= 状態 ================= */
const state = {
  scores: [],
  setlists: [],
  tab: 'library',
  setlistDetail: null,
  search: '',
  sort: (() => { try { return localStorage.getItem('sort') || 'recent'; } catch { return 'recent'; } })(),
};
const findScore = id => state.scores.find(s => s.id === id);
const saveScore = s => DB.put('scores', s);
const saveSetlist = sl => DB.put('setlists', sl);

/* ================= 共通UI ================= */
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function loading(on, text = '読み込み中…') {
  $('#loadingText').textContent = text;
  $('#loading').hidden = !on;
}
function setTop(title, rightHTML = '', backFn = null) {
  $('#title').textContent = title;
  $('#topRight').innerHTML = rightHTML;
  const left = $('#topLeft');
  left.innerHTML = backFn ? `<button class="back-btn" id="backBtn">${ICON.back}<span>戻る</span></button>` : '';
  if (backFn) $('#backBtn').onclick = backFn;
}

function actionSheet(title, items) {
  const el = $('#action'), g = $('#actionGroup');
  g.innerHTML = (title ? `<div class="action-title">${esc(title)}</div>` : '') +
    items.map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 220); };
  g.onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    close();
    items[+b.dataset.i].fn(); // ファイル選択などはユーザー操作中に同期で呼ぶ必要がある
  };
  $('#actionCancel').onclick = close;
  el.onclick = e => { if (e.target === el) close(); };
}

function openSheet({ title, okLabel = '', onOk = null, onClose = null }) {
  const el = $('#sheet'), body = $('#sheetBody'), ok = $('#sheetOk');
  $('#sheetTitle').textContent = title;
  ok.textContent = okLabel;
  ok.hidden = !okLabel;
  body.innerHTML = '';
  body.onclick = null;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; body.innerHTML = ''; }, 250);
    onClose && onClose();
  };
  $('#sheetCancel').onclick = close;
  ok.onclick = async () => {
    ok.disabled = true;
    try { if ((await onOk?.()) !== false) close(); }
    finally { ok.disabled = false; }
  };
  return { body, ok, close };
}

/* ================= PDFユーティリティ ================= */
async function openPdf(buf) {
  // pdf.js はデータをワーカーへ移すので、コピーを渡す
  return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
}
/** 開いたPDFを閉じてメモリを解放（pdf.jsのバージョン差を吸収） */
function closeDoc(doc) {
  if (!doc) return;
  try { (doc.loadingTask || doc).destroy(); } catch {}
}
async function makeThumb(doc, pageNum, width = 120) {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (width * 2) / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.7);
  c.width = 0; c.height = 0;
  return url;
}

/* ================= 取り込み ================= */
async function importFiles(files) {
  if (!files.length) return;
  const errors = [];
  loading(true, `読み込み中…（0/${files.length}）`);
  let i = 0;
  for (const f of files) {
    i++;
    loading(true, `読み込み中…（${i}/${files.length}）`);
    try {
      const buf = await f.arrayBuffer();
      const doc = await openPdf(buf);
      const thumb = await makeThumb(doc, 1);
      const s = {
        id: uid(),
        title: f.name.replace(/\.pdf$/i, ''),
        pageCount: doc.numPages,
        pageOrder: range(doc.numPages),
        addedAt: Date.now(),
        lastOpenedAt: 0,
        lastPos: 0,
        thumb,
      };
      closeDoc(doc);
      await DB.put('files', buf, s.id);
      await saveScore(s);
      state.scores.push(s);
    } catch (e) {
      console.error(e);
      errors.push(`「${f.name}」を読み込めませんでした${e && e.name === 'QuotaExceededError' ? '（保存容量不足）' : ''}`);
    }
  }
  loading(false);
  render();
  if (errors.length) alert(errors.join('\n'));
  else toast(`${files.length}件追加しました`);
}

let replaceTarget = null;
async function replacePdf(file) {
  const s = findScore(replaceTarget);
  if (!s || !file) return;
  loading(true, '差し替え中…');
  try {
    const buf = await file.arrayBuffer();
    const doc = await openPdf(buf);
    const n = doc.numPages;
    let msg = '差し替えました';
    if (n !== s.pageCount) {
      s.pageOrder = range(n);
      s.lastPos = 0;
      await DB.delPrefix('annotations', s.id + ':');
      msg = 'ページ数が変わったため、並び順と書き込みをリセットしました';
    }
    s.pageCount = n;
    s.thumb = await makeThumb(doc, s.pageOrder[0] + 1);
    closeDoc(doc);
    await DB.put('files', buf, s.id);
    await saveScore(s);
    render();
    toast(msg, 3000);
  } catch (e) {
    console.error(e);
    alert('PDFを読み込めませんでした');
  } finally {
    loading(false);
  }
}

async function deleteScore(id) {
  await DB.del('scores', id);
  await DB.del('files', id);
  await DB.delPrefix('annotations', id + ':');
  state.scores = state.scores.filter(s => s.id !== id);
  for (const sl of state.setlists) {
    if (sl.scoreIds.includes(id)) {
      sl.scoreIds = sl.scoreIds.filter(x => x !== id);
      await saveSetlist(sl);
    }
  }
}

async function createSetlist(name, scoreIds = []) {
  const sl = { id: uid(), name, scoreIds, createdAt: Date.now() };
  state.setlists.push(sl);
  await saveSetlist(sl);
  return sl;
}

/* ================= 画面: ライブラリ ================= */
function sortedScores() {
  const q = state.search.trim().toLowerCase();
  const a = state.scores.filter(s => !q || s.title.toLowerCase().includes(q));
  const recent = s => s.lastOpenedAt || s.addedAt;
  if (state.sort === 'recent') a.sort((x, y) => recent(y) - recent(x));
  else if (state.sort === 'added') a.sort((x, y) => y.addedAt - x.addedAt);
  else a.sort((x, y) => x.title.localeCompare(y.title, 'ja', { numeric: true }));
  return a;
}
const scoreRowHTML = (s, right = '') => `
  <li class="row" data-id="${s.id}">
    <img class="thumb" src="${s.thumb || ''}" alt="">
    <div class="row-main">
      <div class="row-title">${esc(s.title)}</div>
      <div class="row-sub">${s.pageOrder.length}ページ</div>
    </div>${right}
  </li>`;

function renderLibrary() {
  setTop('楽譜', `<button class="icon-btn" id="addBtn" aria-label="PDFを追加">${ICON.plus}</button>`);
  $('#addBtn').onclick = () => $('#fileInput').click();
  const main = $('#main');
  if (!state.scores.length) {
    main.innerHTML = `
      <div class="empty">
        <div class="big">♪</div>
        <p class="title">楽譜がありません</p>
        <p>右上の＋からPDFを追加してください。<br>GoogleドライブのPDFも「ブラウズ」→「ドライブ」から選べます。</p>
        <button class="btn primary" id="emptyAdd">PDFを追加</button>
      </div>`;
    $('#emptyAdd').onclick = () => $('#fileInput').click();
    return;
  }
  main.innerHTML = `
    <div class="toolbar">
      <input type="search" id="search" placeholder="楽譜を検索" value="${esc(state.search)}">
      <select id="sort">
        <option value="recent">最近開いた順</option>
        <option value="added">追加順</option>
        <option value="title">名前順</option>
      </select>
    </div>
    <ul class="list" id="scoreList"></ul>`;
  $('#sort').value = state.sort;
  $('#sort').onchange = e => {
    state.sort = e.target.value;
    try { localStorage.setItem('sort', state.sort); } catch {}
    renderScoreList();
  };
  $('#search').oninput = e => { state.search = e.target.value; renderScoreList(); };
  $('#scoreList').onclick = e => {
    const more = e.target.closest('[data-more]');
    if (more) { scoreActions(more.dataset.more); return; }
    const row = e.target.closest('.row[data-id]');
    if (row) openReader([row.dataset.id], 0, true);
  };
  renderScoreList();
}
function renderScoreList() {
  const list = $('#scoreList');
  if (!list) return;
  const a = sortedScores();
  list.innerHTML = a.length
    ? a.map(s => scoreRowHTML(s, `<button class="icon-btn more" data-more="${s.id}" aria-label="メニュー">${ICON.more}</button>`)).join('')
    : `<li class="row"><div class="row-main row-sub">見つかりません</div></li>`;
}

function scoreActions(id) {
  const s = findScore(id);
  if (!s) return;
  actionSheet(s.title, [
    { label: '名前を変更', fn: async () => {
      const t = prompt('新しい名前', s.title);
      if (t && t.trim()) { s.title = t.trim(); await saveScore(s); render(); }
    } },
    { label: 'ページを並べ替え', fn: () => openPageEditor(id) },
    { label: 'セットリストに追加', fn: () => openAddToSetlist(id) },
    { label: 'PDFを差し替え（ドライブで更新したとき）', fn: () => { replaceTarget = id; $('#replaceInput').click(); } },
    { label: '削除', danger: true, fn: async () => {
      if (confirm(`「${s.title}」を削除しますか？\n書き込みも削除されます（Googleドライブの元ファイルは消えません）`)) {
        await deleteScore(id); render();
      }
    } },
  ]);
}

/* ================= 画面: セットリスト ================= */
function renderSetlists() {
  if (state.setlistDetail && state.setlists.some(x => x.id === state.setlistDetail)) return renderSetlistDetail();
  state.setlistDetail = null;
  setTop('セットリスト', `<button class="icon-btn" id="newSl" aria-label="新規作成">${ICON.plus}</button>`);
  $('#newSl').onclick = async () => {
    const n = prompt('セットリストの名前', '');
    if (n === null) return;
    const sl = await createSetlist(n.trim() || 'セットリスト');
    state.setlistDetail = sl.id;
    render();
  };
  const main = $('#main');
  if (!state.setlists.length) {
    main.innerHTML = `
      <div class="empty">
        <div class="big">☰</div>
        <p class="title">セットリストがありません</p>
        <p>＋から作成して、演奏順に楽譜を並べられます。<br>本番では曲の最後から次の曲へそのままめくれます。</p>
      </div>`;
    return;
  }
  const lists = state.setlists.slice().sort((a, b) => b.createdAt - a.createdAt);
  main.innerHTML = `<ul class="list" id="slList">${lists.map(sl => `
    <li class="row" data-id="${sl.id}">
      <div class="row-main"><div class="row-title">${esc(sl.name)}</div><div class="row-sub">${sl.scoreIds.length}曲</div></div>
      <button class="icon-btn more" data-more="${sl.id}" aria-label="メニュー">${ICON.more}</button>
    </li>`).join('')}</ul>`;
  $('#slList').onclick = e => {
    const more = e.target.closest('[data-more]');
    if (more) {
      const sl = state.setlists.find(x => x.id === more.dataset.more);
      actionSheet(sl.name, [
        { label: '名前を変更', fn: async () => {
          const n = prompt('新しい名前', sl.name);
          if (n && n.trim()) { sl.name = n.trim(); await saveSetlist(sl); render(); }
        } },
        { label: '削除', danger: true, fn: async () => {
          if (confirm(`セットリスト「${sl.name}」を削除しますか？\n（楽譜そのものは消えません）`)) {
            state.setlists = state.setlists.filter(x => x.id !== sl.id);
            await DB.del('setlists', sl.id);
            render();
          }
        } },
      ]);
      return;
    }
    const row = e.target.closest('.row');
    if (row) { state.setlistDetail = row.dataset.id; render(); }
  };
}

function renderSetlistDetail() {
  const sl = state.setlists.find(x => x.id === state.setlistDetail);
  setTop(sl.name, `<button class="icon-btn" id="addToSl" aria-label="楽譜を追加">${ICON.plus}</button>`,
    () => { state.setlistDetail = null; render(); });
  sl.scoreIds = sl.scoreIds.filter(id => findScore(id));
  const ids = sl.scoreIds;
  const main = $('#main');
  main.innerHTML = `
    <div class="section"><button class="btn primary wide" id="playAll" ${ids.length ? '' : 'disabled'}>${ICON.play}最初から演奏</button></div>
    ${ids.length ? `<ul class="list" id="slScores">${ids.map((id, i) => {
      const s = findScore(id);
      return `<li class="row" data-i="${i}">
        <span class="row-num">${i + 1}</span>
        <img class="thumb" src="${s.thumb || ''}" alt="">
        <div class="row-main"><div class="row-title">${esc(s.title)}</div><div class="row-sub">${s.pageOrder.length}ページ</div></div>
        <div class="row-ctrl">
          <button data-act="up" aria-label="上へ">↑</button>
          <button data-act="down" aria-label="下へ">↓</button>
          <button data-act="del" class="del" aria-label="外す">✕</button>
        </div>
      </li>`;
    }).join('')}</ul>` : `<p class="empty">右上の＋から楽譜を追加してください</p>`}`;
  $('#addToSl').onclick = () => openScorePicker(async picked => {
    sl.scoreIds = sl.scoreIds.concat(picked);
    await saveSetlist(sl);
    render();
  });
  $('#playAll').onclick = () => openReader(ids.slice(), 0, false);
  const list = $('#slScores');
  if (list) list.onclick = async e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = +row.dataset.i;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) { openReader(ids.slice(), i, false); return; }
    if (act === 'up' && i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    else if (act === 'down' && i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
    else if (act === 'del') ids.splice(i, 1);
    else return;
    await saveSetlist(sl);
    renderSetlistDetail();
  };
}

/** 複数選択の楽譜ピッカー（タップした順に番号が付き、その順で追加される） */
function openScorePicker(onPick) {
  let sel = [];
  const sh = openSheet({
    title: '楽譜を追加', okLabel: '追加',
    onOk: () => { if (!sel.length) return false; onPick(sel); },
  });
  const scores = state.scores.slice().sort((a, b) => a.title.localeCompare(b.title, 'ja', { numeric: true }));
  const draw = () => {
    sh.body.innerHTML = scores.length
      ? `<ul class="list">${scores.map(s => {
          const i = sel.indexOf(s.id);
          return scoreRowHTML(s, `<span class="badge ${i >= 0 ? 'on' : ''}">${i >= 0 ? i + 1 : ''}</span>`);
        }).join('')}</ul>`
      : `<p class="empty">先に「楽譜」タブでPDFを追加してください</p>`;
    sh.ok.textContent = `追加（${sel.length}）`;
  };
  sh.body.onclick = e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    sel = sel.includes(id) ? sel.filter(x => x !== id) : sel.concat(id);
    draw();
  };
  draw();
}

function openAddToSetlist(scoreId) {
  const sh = openSheet({ title: 'セットリストに追加' });
  const lists = state.setlists.slice().sort((a, b) => b.createdAt - a.createdAt);
  sh.body.innerHTML = `
    <div class="section"><button class="btn primary wide" id="newSlAdd">＋ 新しいセットリストを作って追加</button></div>
    ${lists.length ? `<ul class="list">${lists.map(sl => `
      <li class="row" data-id="${sl.id}">
        <div class="row-main"><div class="row-title">${esc(sl.name)}</div>
        <div class="row-sub">${sl.scoreIds.length}曲${sl.scoreIds.includes(scoreId) ? '・追加済み' : ''}</div></div>
      </li>`).join('')}</ul>` : ''}`;
  $('#newSlAdd').onclick = async () => {
    const n = prompt('セットリストの名前', '');
    if (n === null) return;
    const sl = await createSetlist(n.trim() || 'セットリスト', [scoreId]);
    sh.close();
    toast(`「${sl.name}」に追加しました`);
    render();
  };
  sh.body.onclick = async e => {
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    const sl = state.setlists.find(x => x.id === row.dataset.id);
    sl.scoreIds.push(scoreId);
    await saveSetlist(sl);
    sh.close();
    toast(`「${sl.name}」に追加しました`);
    render();
  };
}

/* ================= ページ編集（並べ替え・複製・削除） ================= */
// PDF本体は変えず、表示順 pageOrder だけを書き換える。
// D.S.やリピートで戻る箇所のページを複製して並べれば、演奏順にめくるだけで済む。
async function openPageEditor(scoreId) {
  const s = findScore(scoreId);
  if (!s) return;
  let items = s.pageOrder.map(p => ({ p, k: uid() }));
  const thumbs = new Map();
  let doc = null, closed = false;

  const sh = openSheet({
    title: 'ページの並べ替え', okLabel: '保存',
    onOk: async () => {
      if (!items.length) { alert('1ページ以上必要です'); return false; }
      const oldFirst = s.pageOrder[0];
      s.pageOrder = items.map(i => i.p);
      s.lastPos = 0;
      if (s.pageOrder[0] !== oldFirst && thumbs.has(s.pageOrder[0])) s.thumb = thumbs.get(s.pageOrder[0]);
      await saveScore(s);
      render();
      if (R.open && currentScore()?.id === s.id) { R.pos = 0; show(0); }
    },
    onClose: () => { closed = true; closeDoc(doc); },
  });

  const draw = () => {
    sh.body.innerHTML = `
      <p class="sheet-note">↑↓で並べ替え、⧉で複製（リピートやD.S.で戻る箇所に便利）、✕で非表示にします。PDF本体は変更されません。</p>
      <div class="section"><button class="btn small" id="resetOrder">元の順序に戻す</button></div>
      <ul class="list">${items.map((it, i) => `
        <li class="row" data-i="${i}">
          <img class="thumb" data-p="${it.p}" src="${thumbs.get(it.p) || ''}" alt="">
          <div class="row-main"><div class="row-title">${i + 1}番目</div><div class="row-sub">元のPDFの${it.p + 1}ページ</div></div>
          <div class="row-ctrl">
            <button data-act="up" aria-label="上へ">↑</button>
            <button data-act="down" aria-label="下へ">↓</button>
            <button data-act="dup" aria-label="複製">⧉</button>
            <button data-act="del" class="del" aria-label="削除">✕</button>
          </div>
        </li>`).join('')}</ul>`;
    $('#resetOrder').onclick = () => { items = range(s.pageCount).map(p => ({ p, k: uid() })); draw(); };
  };
  sh.body.onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const row = e.target.closest('.row');
    if (!act || !row) return;
    const i = +row.dataset.i;
    if (act === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
    else if (act === 'down' && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
    else if (act === 'dup') items.splice(i + 1, 0, { p: items[i].p, k: uid() });
    else if (act === 'del') items.splice(i, 1);
    else return;
    draw();
  };
  draw();

  // サムネイルを順に作る
  try {
    const buf = await DB.get('files', s.id);
    doc = await openPdf(buf);
    for (let p = 0; p < s.pageCount; p++) {
      if (closed) return;
      const url = await makeThumb(doc, p + 1, 90);
      thumbs.set(p, url);
      sh.body.querySelectorAll(`img[data-p="${p}"]`).forEach(img => { img.src = url; });
    }
  } catch (e) { console.error(e); }
}

/* ================= 画面: 設定 ================= */
function renderSettings() {
  setTop('設定');
  const sw = (k, label) => `
    <label class="item"><span>${label}</span>
      <span class="switch"><input type="checkbox" data-k="${k}" ${settings[k] ? 'checked' : ''}><span></span></span>
    </label>`;
  $('#main').innerHTML = `
    <div class="group-title">表示</div>
    <div class="group">
      ${sw('spread', '横向きで見開き表示')}
      ${sw('stepOne', '見開き時は1ページずつ送る')}
      ${sw('anim', 'ページめくりアニメーション')}
      ${sw('wake', '楽譜表示中は画面をスリープしない')}
    </div>

    <div class="group-title">ページのめくり方</div>
    <div class="group text">
      <p>右側をタップ / 左へスワイプ：次へ</p>
      <p>左側をタップ / 右へスワイプ：前へ</p>
      <p>中央をタップ：メニューの表示・非表示</p>
      <p>Bluetoothペダル：→ ↓ PageDown Space で次へ、← ↑ PageUp で前へ</p>
    </div>

    <div class="group-title">Googleドライブから追加するには</div>
    <div class="group text">
      <p>1. iPhoneに「Google ドライブ」アプリを入れてログインします。</p>
      <p>2. 楽譜タブの＋ →「ブラウズ」→ 右上の「…」→「編集」で「ドライブ」をオンにします。</p>
      <p>3. 以降は＋ →「ドライブ」からPDFを選ぶだけです（複数選択可）。</p>
      <p class="note">取り込んだPDFはiPhone内に保存されるので、オフラインでも表示できます。ドライブ側を更新したときは、楽譜の「…」→「PDFを差し替え」で入れ替えられます（並び順と書き込みは引き継がれます）。</p>
    </div>

    <div class="group-title">保存領域</div>
    <div class="group text" id="storageInfo">確認中…</div>`;
  $('#main').querySelectorAll('input[data-k]').forEach(inp => {
    inp.onchange = () => { settings[inp.dataset.k] = inp.checked; saveSettings(); };
  });
  (async () => {
    const el = $('#storageInfo');
    if (!el) return;
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
      el.innerHTML = `<p>使用量: ${est ? mb(est.usage) : '不明'}${est?.quota ? ` / 上限の目安 ${mb(est.quota)}` : ''}</p>
        <p class="note">${persisted ? '保存データは自動削除されにくい設定になっています。' : 'ホーム画面に追加して使うと、保存データが消えにくくなります。'}</p>`;
    } catch { el.textContent = '確認できませんでした'; }
  })();
}

/* ================= ルーティング ================= */
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'library') renderLibrary();
  else if (state.tab === 'setlists') renderSetlists();
  else renderSettings();
}

/* =====================================================================
 * 楽譜表示（リーダー）
 * ===================================================================== */
const R = {
  open: false,
  scoreIds: [], si: 0, pos: 0,
  doc: null, docFor: null, docPromise: null,
  cache: new Map(),   // key -> Promise<{canvas, cssW, cssH}>
  curView: null,
  token: 0,
  w: 0, h: 0, spread: false,
  ink: false,
  undo: [],
};
const CACHE_LIMIT = 8;
const currentScore = () => findScore(R.scoreIds[R.si]);
const stepSize = () => (R.spread && !settings.stepOne ? 2 : 1);

function measure() {
  const st = $('#stage');
  R.w = st.clientWidth;
  R.h = st.clientHeight;
  R.spread = settings.spread && !R.ink && R.w > R.h;
}

function clearCache() {
  for (const p of R.cache.values()) p.then(e => { e.canvas.width = 0; e.canvas.height = 0; }).catch(() => {});
  R.cache.clear();
}

function ensureDoc(score) {
  if (R.docFor === score.id && R.docPromise) return R.docPromise;
  R.docFor = score.id;
  const old = R.doc;
  R.doc = null;
  clearCache();
  closeDoc(old);
  R.docPromise = (async () => {
    const buf = await DB.get('files', score.id);
    if (!buf) throw new Error('PDFデータが見つかりません');
    const doc = await openPdf(buf);
    if (R.docFor !== score.id) { closeDoc(doc); throw new Error('stale'); }
    R.doc = doc;
    score.lastOpenedAt = Date.now();
    saveScore(score);
    return doc;
  })();
  return R.docPromise;
}

/** 1ページを画面サイズに合わせて描画（結果はキャッシュ） */
function renderPage(doc, scoreId, pageIdx, slotW, slotH) {
  const key = `${scoreId}:${pageIdx}:${slotW}x${slotH}`;
  if (R.cache.has(key)) {
    const p = R.cache.get(key);
    R.cache.delete(key); R.cache.set(key, p); // LRU
    return p;
  }
  const p = (async () => {
    const page = await doc.getPage(pageIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const fit = Math.min(slotW / vp1.width, slotH / vp1.height);
    const cssW = Math.max(1, Math.floor(vp1.width * fit));
    const cssH = Math.max(1, Math.floor(vp1.height * fit));
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    const MAX_PX = 6e6; // iOS Safari のキャンバスメモリ上限対策
    if (cssW * cssH * dpr * dpr > MAX_PX) dpr = Math.sqrt(MAX_PX / (cssW * cssH));
    const vp = page.getViewport({ scale: fit * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas: c, cssW, cssH };
  })();
  R.cache.set(key, p);
  p.catch(() => R.cache.delete(key));
  while (R.cache.size > CACHE_LIMIT) {
    const oldest = R.cache.keys().next().value;
    const op = R.cache.get(oldest);
    R.cache.delete(oldest);
    op.then(e => { e.canvas.width = 0; e.canvas.height = 0; }).catch(() => {});
  }
  return p;
}

/** 現在位置のページを表示する。dir: 1=次へ, -1=前へ, 0=アニメなし */
async function show(dir = 0) {
  const token = ++R.token;
  const sc = currentScore();
  if (!sc) { closeReader(); return; }
  updateChrome();
  let doc;
  try { doc = await ensureDoc(sc); }
  catch (e) { if (e.message !== 'stale') { console.error(e); alert('PDFを開けませんでした'); } return; }
  if (token !== R.token) return;
  measure();
  updateChrome();
  const order = sc.pageOrder;
  R.pos = Math.min(Math.max(0, R.pos), order.length - 1);
  const positions = (R.spread ? [R.pos, R.pos + 1] : [R.pos]).filter(p => p < order.length);
  const slotW = R.spread ? Math.floor(R.w / 2) : R.w;
  const slotH = R.h;

  let entries;
  try { entries = await Promise.all(positions.map(p => renderPage(doc, sc.id, order[p], slotW, slotH))); }
  catch (e) { console.error(e); return; }
  if (token !== R.token) return;

  const view = document.createElement('div');
  view.className = 'view' + (R.spread ? ' spread' : '');
  const slots = R.spread ? 2 : 1;
  for (let i = 0; i < slots; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const e = entries[i];
    if (e) {
      const wrap = document.createElement('div');
      wrap.className = 'page';
      wrap.style.width = e.cssW + 'px';
      wrap.style.height = e.cssH + 'px';
      // キャッシュのキャンバスは使い回すので、表示用にコピーする
      const c = document.createElement('canvas');
      c.width = e.canvas.width; c.height = e.canvas.height;
      c.style.width = e.cssW + 'px'; c.style.height = e.cssH + 'px';
      c.getContext('2d', { alpha: false }).drawImage(e.canvas, 0, 0);
      wrap.append(c, createInk(sc.id, order[positions[i]], e.cssW, e.cssH));
      slot.append(wrap);
    }
    view.append(slot);
  }
  swapView(view, dir);
  if (sc.lastPos !== R.pos) { sc.lastPos = R.pos; saveScore(sc); }
  prefetch(doc, sc, slotW, slotH, token);
}

function swapView(view, dir) {
  const stage = $('#stage');
  [...stage.children].forEach(v => { if (v !== R.curView) disposeView(v); });
  const old = R.curView;
  R.curView = view;
  if (old && dir && settings.anim) {
    view.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
    stage.append(view);
    view.getBoundingClientRect(); // 強制レイアウトしてからアニメーション開始
    view.classList.add('anim');
    old.classList.add('anim');
    view.style.transform = 'translateX(0)';
    old.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;
    setTimeout(() => disposeView(old), 260);
  } else {
    stage.append(view);
    if (old) disposeView(old);
  }
}
function disposeView(v) {
  if (!v || !v.parentNode) return;
  v.querySelectorAll('canvas').forEach(c => { c.width = 0; c.height = 0; });
  v.remove();
}

/** 次・前のページを先に描画しておき、めくった瞬間に表示できるようにする */
function prefetch(doc, sc, slotW, slotH, token) {
  const order = sc.pageOrder, step = stepSize(), targets = [];
  for (const d of [step, step + 1, -step, -step + 1, 2 * step, 2 * step + 1]) {
    const p = R.pos + d;
    if (p >= 0 && p < order.length && !targets.includes(order[p])) targets.push(order[p]);
  }
  (async () => {
    for (const pg of targets) {
      if (token !== R.token) return;
      try { await renderPage(doc, sc.id, pg, slotW, slotH); } catch {}
    }
  })();
}

function next() {
  const sc = currentScore();
  if (!sc) return;
  const step = stepSize(), n = sc.pageOrder.length;
  if (R.pos + step < n) { R.pos += step; show(1); }
  else if (R.si + 1 < R.scoreIds.length) { R.si++; R.pos = 0; show(1); }
  else { toast('最後のページです', 1200); navigator.vibrate?.(30); }
}
function prev() {
  const sc = currentScore();
  if (!sc) return;
  const step = stepSize();
  if (R.pos > 0) { R.pos = Math.max(0, R.pos - step); show(-1); }
  else if (R.si > 0) {
    R.si--;
    const n = currentScore().pageOrder.length;
    R.pos = Math.max(0, Math.floor((n - 1) / step) * step);
    show(-1);
  } else { toast('最初のページです', 1200); }
}

function updateChrome() {
  const sc = currentScore();
  if (!sc) return;
  const n = sc.pageOrder.length;
  $('#rTitle').textContent = sc.title;
  $('#rSub').textContent = R.scoreIds.length > 1 ? `セットリスト ${R.si + 1} / ${R.scoreIds.length} 曲目` : '';
  $('#rPage').textContent = R.spread && R.pos + 1 < n ? `${R.pos + 1}-${R.pos + 2} / ${n}` : `${R.pos + 1} / ${n}`;
  const sl = $('#rSlider');
  sl.max = Math.max(0, n - 1);
  sl.value = R.pos;
  $('#rBottom').style.visibility = n > 1 ? 'visible' : 'hidden';
}

function openReader(scoreIds, startIndex, resume) {
  if (!scoreIds.length) return;
  R.open = true;
  R.scoreIds = scoreIds;
  R.si = startIndex;
  R.pos = resume ? (currentScore()?.lastPos || 0) : 0;
  R.ink = false;
  R.undo = [];
  const el = $('#reader');
  el.hidden = false;
  el.classList.remove('inking', 'chrome-hidden');
  $('#inkTools').hidden = true;
  $('#rPrev').hidden = $('#rNext').hidden = true;
  $('#rInk').classList.remove('on');
  acquireWake();
  show(0);
  // 少ししたらメニューを隠して楽譜を広く見せる
  setTimeout(() => { if (R.open && !R.ink) el.classList.add('chrome-hidden'); }, 1800);
}

function closeReader() {
  R.open = false;
  R.token++;
  $('#reader').hidden = true;
  disposeView(R.curView);
  [...$('#stage').children].forEach(disposeView);
  R.curView = null;
  clearCache();
  closeDoc(R.doc);
  R.doc = null; R.docFor = null; R.docPromise = null;
  releaseWake();
  render();
}

function toggleChrome() { $('#reader').classList.toggle('chrome-hidden'); }

function setInk(on) {
  R.ink = on;
  const el = $('#reader');
  el.classList.toggle('inking', on);
  $('#inkTools').hidden = !on;
  $('#rPrev').hidden = $('#rNext').hidden = !on;
  $('#rInk').classList.toggle('on', on);
  $('#rPages').hidden = on;
  if (!on) setTimeout(() => el.classList.add('chrome-hidden'), 600);
  show(0); // 書き込み中は見開きを解除するので再描画
}

/* ---------- 画面操作 ---------- */
(() => {
  let start = null;
  const tap = $('#tapLayer');
  tap.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY }; });
  tap.addEventListener('pointerup', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const x = e.clientX / window.innerWidth;
      if (x < 0.3) prev();
      else if (x > 0.7) next();
      else toggleChrome();
    } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      dx < 0 ? next() : prev();
    }
  });
  tap.addEventListener('pointercancel', () => { start = null; });
})();

// Bluetoothページめくりペダル（キーボードとして接続される）
document.addEventListener('keydown', e => {
  if (!R.open || !$('#sheet').hidden) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!R.open) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => show(0), 150);
});

/* ---------- スリープ防止 ---------- */
let wakeLock = null;
async function acquireWake() {
  if (!settings.wake || !('wakeLock' in navigator) || !R.open) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && R.open) acquireWake();
});

/* =====================================================================
 * 書き込み（ペン・蛍光ペン・消しゴム）
 * 座標はページ幅・高さに対する割合で保存するので、画面サイズが変わってもずれない
 * ===================================================================== */
const Ink = {
  tool: 'pen', color: '#111111', width: 1,
  widths: [0.0018, 0.0032, 0.0055],
  widthFrac() { return this.widths[this.width] * (this.tool === 'hl' ? 5 : 1); },
};

function createInk(scoreId, pageIdx, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.className = 'ink';
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ink = { canvas: c, key: `${scoreId}:${pageIdx}`, strokes: [], w, h, dpr, cur: null };
  DB.get('annotations', ink.key).then(s => { ink.strokes = s || []; redrawInk(ink); }).catch(() => {});

  const pt = e => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redrawInk(ink); }); };

  c.addEventListener('pointerdown', e => {
    if (!R.ink) return;
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    if (Ink.tool === 'eraser') {
      ink.cur = { erase: true, before: ink.strokes.slice() };
      eraseAt(ink, pt(e));
    } else {
      ink.cur = { t: Ink.tool, c: Ink.color, w: Ink.widthFrac(), p: pt(e) };
    }
    schedule();
  });
  c.addEventListener('pointermove', e => {
    if (!ink.cur) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const p = pt(ev);
      if (ink.cur.erase) eraseAt(ink, p);
      else ink.cur.p.push(p[0], p[1]);
    }
    schedule();
  });
  const end = () => {
    const cur = ink.cur;
    if (!cur) return;
    ink.cur = null;
    if (cur.erase) {
      if (cur.before.length !== ink.strokes.length) { R.undo.push({ ink, before: cur.before }); saveInk(ink); }
    } else {
      if (cur.p.length === 2) cur.p.push(cur.p[0] + 0.0005, cur.p[1]); // タップは点として残す
      R.undo.push({ ink, before: ink.strokes.slice() });
      ink.strokes.push({ t: cur.t, c: cur.c, w: cur.w, p: cur.p.map(v => Math.round(v * 10000) / 10000) });
      saveInk(ink);
    }
    schedule();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  return c;
}

function eraseAt(ink, [x, y]) {
  const th = 14; // px
  ink.strokes = ink.strokes.filter(s => {
    for (let i = 0; i < s.p.length; i += 2) {
      if (Math.hypot((s.p[i] - x) * ink.w, (s.p[i + 1] - y) * ink.h) < th) return false;
    }
    return true;
  });
}

function drawStroke(ctx, s, W, H) {
  const p = s.p;
  if (p.length < 4) return;
  ctx.save();
  ctx.strokeStyle = s.c;
  ctx.lineWidth = Math.max(1, s.w * W);
  ctx.lineCap = s.t === 'hl' ? 'butt' : 'round';
  ctx.lineJoin = 'round';
  if (s.t === 'hl') { ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply'; }
  ctx.beginPath();
  ctx.moveTo(p[0] * W, p[1] * H);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    ctx.quadraticCurveTo(p[i] * W, p[i + 1] * H, mx * W, my * H);
  }
  ctx.lineTo(p[p.length - 2] * W, p[p.length - 1] * H);
  ctx.stroke();
  ctx.restore();
}

function redrawInk(ink) {
  const c = ink.canvas;
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  for (const s of ink.strokes) drawStroke(ctx, s, c.width, c.height);
  if (ink.cur && !ink.cur.erase) drawStroke(ctx, ink.cur, c.width, c.height);
}

function saveInk(ink) {
  (ink.strokes.length ? DB.put('annotations', ink.strokes, ink.key) : DB.del('annotations', ink.key)).catch(() => {});
}

/* ---------- 書き込みツールバー ---------- */
$('#inkTools').addEventListener('click', e => {
  const tool = e.target.closest('.tool');
  if (tool) {
    document.querySelectorAll('#inkTools .tool').forEach(b => b.classList.toggle('sel', b === tool));
    Ink.tool = tool.dataset.tool;
    if (tool.dataset.color) Ink.color = tool.dataset.color;
  }
});
// 太さはタップするたびに 細 → 中 → 太 と切り替え
$('#inkWidth').onclick = () => {
  Ink.width = (Ink.width + 1) % 3;
  $('#inkWidth').textContent = ['細', '中', '太'][Ink.width];
};
$('#inkUndo').onclick = () => {
  const u = R.undo.pop();
  if (!u) { toast('元に戻す操作はありません', 1200); return; }
  u.ink.strokes = u.before;
  saveInk(u.ink);
  redrawInk(u.ink);
};
$('#inkDone').onclick = () => setInk(false);

/* =====================================================================
 * 起動
 * ===================================================================== */
function bindStatic() {
  document.querySelectorAll('.tabbar button').forEach(b => {
    b.onclick = () => {
      if (state.tab === b.dataset.tab && b.dataset.tab === 'setlists') state.setlistDetail = null;
      state.tab = b.dataset.tab;
      render();
      $('#main').scrollTop = 0;
    };
  });
  $('#fileInput').onchange = e => {
    const files = [...e.target.files];
    e.target.value = '';
    importFiles(files);
  };
  $('#replaceInput').onchange = e => {
    const f = e.target.files[0];
    e.target.value = '';
    replacePdf(f);
  };
  $('#rClose').onclick = closeReader;
  $('#rPrev').onclick = prev;
  $('#rNext').onclick = next;
  $('#rInk').onclick = () => setInk(!R.ink);
  $('#rPages').onclick = () => { const s = currentScore(); if (s) openPageEditor(s.id); };
  $('#rSlider').oninput = e => { R.pos = +e.target.value; show(0); };
}

async function init() {
  if (!window.pdfjsLib) {
    $('#main').innerHTML = '<div class="empty"><p class="title">PDF表示ライブラリを読み込めませんでした</p><p>初回はインターネットに接続した状態で開いてください。</p></div>';
    return;
  }
  bindStatic();
  try {
    [state.scores, state.setlists] = await Promise.all([DB.all('scores'), DB.all('setlists')]);
  } catch (e) {
    console.error(e);
    alert('保存データを読み込めませんでした（プライベートブラウズでは保存できません）');
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // 端末の空き容量が減ってもデータが消されにくくなるよう要求する
  navigator.storage?.persist?.().catch(() => {});
}

init();
