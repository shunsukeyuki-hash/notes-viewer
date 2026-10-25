(() => {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const PDF_CACHE = 'pdf-v1';
  const ROOT_NAME = 'ノート';

  const $ = (id) => document.getElementById(id);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  const state = {
    token: null,
    exp: 0,
    rootId: ls.get('rootId') || ''
  };
  let navSeq = 0;
  let pdfDoc = null;
  let observer = null;

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ---------- 小さなユーティリティ ---------- */

  function setStatus(msg) { $('status').textContent = msg || ''; }
  function showSignin(show) { $('signin').hidden = !show; }
  function authErr(msg) { return Object.assign(new Error(msg), { auth: true }); }

  function waitFor(cond, ms = 10000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        if (cond()) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error('Googleの読み込みがタイムアウトしました'));
        setTimeout(poll, 100);
      })();
    });
  }

  function parseFolderId(s) {
    s = (s || '').trim();
    const m = s.match(/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
    if (m) return m[1];
    return /^[\w-]{10,}$/.test(s) ? s : '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- 認証 (Google Identity Services) ---------- */

  function getToken(interactive = false) {
    if (state.token && Date.now() < state.exp - 60000) return Promise.resolve(state.token);
    if (!interactive && !ls.get('signedIn')) return Promise.reject(authErr('not signed in'));
    if (/YOUR_CLIENT_ID/.test(window.CONFIG && CONFIG.CLIENT_ID || '')) {
      return Promise.reject(new Error('config.js にクライアントIDを設定してください'));
    }
    return waitFor(() => window.google && google.accounts && google.accounts.oauth2)
      .then(() => new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.CLIENT_ID,
          scope: SCOPE,
          callback: (r) => {
            if (r.error) return reject(authErr(r.error));
            state.token = r.access_token;
            state.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
            ls.set('signedIn', '1');
            resolve(state.token);
          },
          error_callback: (e) => reject(authErr((e && e.type) || 'auth_error'))
        });
        // 起動時は画面を出さずに取得(none)、ボタン操作時は必要なら同意画面を出す('')
        client.requestAccessToken({ prompt: interactive ? '' : 'none' });
      }));
  }

  async function authFetch(url) {
    let t = await getToken();
    let r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401) {
      state.token = null;
      t = await getToken();
      r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
    }
    if (r.status === 401) throw authErr('unauthorized');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  }

  function handleError(e, hasCache) {
    if (e && e.auth) {
      setStatus(hasCache ? 'ログインが必要です（保存済みの一覧を表示中）' : 'ログインが必要です');
      showSignin(true);
    } else {
      setStatus('エラー: ' + (e && e.message ? e.message : e));
    }
  }

  /* ---------- Drive: 一覧 ---------- */

  async function listFolder(id) {
    const q = `'${id}' in parents and trashed=false and ` +
      `(mimeType='application/pdf' or mimeType='application/vnd.google-apps.folder')`;
    let files = [];
    let pageToken = '';
    do {
      const params = {
        q,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
        orderBy: 'folder,modifiedTime desc',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      };
      if (pageToken) params.pageToken = pageToken;
      const res = await authFetch(`${API}?${new URLSearchParams(params)}`);
      const j = await res.json();
      files = files.concat(j.files || []);
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  function drawList(files) {
    const ul = $('list');
    ul.innerHTML = '';
    for (const f of files) {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<span class="ico"></span><span class="meta"><span class="name"></span><span class="date"></span></span>';
      b.querySelector('.ico').textContent = isFolder ? '📁' : '📄';
      b.querySelector('.name').textContent = isFolder ? f.name : f.name.replace(/\.pdf$/i, '');
      b.querySelector('.date').textContent = isFolder ? '' : fmtDate(f.modifiedTime);
      b.onclick = () => navigate(isFolder
        ? { t: 'folder', id: f.id, name: f.name }
        : { t: 'pdf', id: f.id, name: f.name.replace(/\.pdf$/i, ''), mt: f.modifiedTime });
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  /* ---------- Drive: PDF 取得（キャッシュ付き） ---------- */

  async function findCachedKey(cache, id) {
    for (const k of await cache.keys()) {
      if (new URL(k.url).pathname.startsWith(`/__pdf/${id}/`)) return k;
    }
    return null;
  }

  async function getPdfBlob({ id, mt }) {
    const cache = await caches.open(PDF_CACHE);
    const key = `/__pdf/${id}/${encodeURIComponent(mt || '')}`;
    const hit = await cache.match(key);
    if (hit) return hit.blob(); // 更新日時が同じ版が保存済み

    try {
      if (!navigator.onLine) throw new Error('オフラインです');
      const r = await authFetch(`${API}/${id}?alt=media&supportsAllDrives=true`);
      const blob = await r.blob();
      let old;
      while ((old = await findCachedKey(cache, id))) await cache.delete(old);
      await cache.put(key, new Response(blob));
      return blob;
    } catch (e) {
      const k = await findCachedKey(cache, id); // 取得失敗時は古い版でも表示
      if (k) return (await cache.match(k)).blob();
      throw e;
    }
  }

  /* ---------- PDF 表示 (pdf.js) ---------- */

  async function drawPage(c) {
    const out = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = c._page.getViewport({ scale: c._scale * out });
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await c._page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }

  async function renderPdf(blob, seq) {
    const v = $('viewer');
    v.innerHTML = '';
    if (observer) { observer.disconnect(); observer = null; }
    if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }

    const data = new Uint8Array(await blob.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    if (seq !== navSeq) { pdf.destroy(); return; }
    pdfDoc = pdf;

    const width = v.clientWidth || window.innerWidth;
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          observer.unobserve(e.target);
          drawPage(e.target);
        }
      }
    }, { rootMargin: '800px 0px' });

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (seq !== navSeq) return;
      const vp = page.getViewport({ scale: 1 });
      const scale = width / vp.width;
      const c = document.createElement('canvas');
      c.className = 'page';
      c.style.width = width + 'px';
      c.style.height = Math.round(vp.height * scale) + 'px';
      c._page = page;
      c._scale = scale;
      v.appendChild(c);
      observer.observe(c);
    }
  }

  async function showPdf(st) {
    const seq = ++navSeq;
    $('list').hidden = true;
    $('viewer').hidden = false;
    $('viewer').innerHTML = '';
    showSignin(false);
    setStatus('読み込み中…');
    try {
      const blob = await getPdfBlob(st);
      if (seq !== navSeq) return;
      await renderPdf(blob, seq);
      if (seq === navSeq) setStatus('');
    } catch (e) {
      if (seq === navSeq) handleError(e, false);
    }
  }

  /* ---------- フォルダ表示 ---------- */

  async function showFolder(id) {
    const seq = ++navSeq;
    if (observer) { observer.disconnect(); observer = null; }
    $('viewer').hidden = true;
    $('viewer').innerHTML = '';
    $('list').hidden = false;
    showSignin(false);

    let cached = null;
    try { cached = JSON.parse(ls.get('list:' + id) || 'null'); } catch { /* ignore */ }
    if (cached) drawList(cached); else $('list').innerHTML = '';

    if (!navigator.onLine) {
      setStatus(cached ? 'オフライン：保存済みの一覧を表示中' : 'オフラインです');
      return;
    }
    setStatus('更新中…');
    try {
      const files = await listFolder(id);
      if (seq !== navSeq) return;
      ls.set('list:' + id, JSON.stringify(files));
      drawList(files);
      setStatus(files.length ? '' : 'このフォルダにPDFはありません');
    } catch (e) {
      if (seq === navSeq) handleError(e, !!cached);
    }
  }

  /* ---------- ナビゲーション ---------- */

  function render(st) {
    $('title').textContent = st.name || ROOT_NAME;
    $('back').hidden = (st.t === 'folder' && st.id === state.rootId);
    if (st.t === 'pdf') showPdf(st); else showFolder(st.id);
  }

  function navigate(st) {
    history.pushState(st, '');
    render(st);
  }

  window.addEventListener('popstate', (e) => {
    render(e.state || { t: 'folder', id: state.rootId, name: ROOT_NAME });
  });

  /* ---------- UI ---------- */

  $('back').onclick = () => history.back();
  $('refresh').onclick = () => render(history.state || { t: 'folder', id: state.rootId, name: ROOT_NAME });

  $('signin').onclick = async () => {
    try {
      await getToken(true);
      showSignin(false);
      render(history.state || { t: 'folder', id: state.rootId, name: ROOT_NAME });
    } catch (e) {
      handleError(e, false);
    }
  };

  const dlg = $('dlg');
  function openSettings() {
    $('folderInput').value = state.rootId ? `https://drive.google.com/drive/folders/${state.rootId}` : '';
    dlg.showModal();
  }
  $('settings').onclick = openSettings;

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const id = parseFolderId($('folderInput').value);
    if (!id) {
      alert('フォルダのURLまたはIDを読み取れませんでした。');
      openSettings();
      return;
    }
    state.rootId = id;
    ls.set('rootId', id);
    start();
  });

  $('signout').onclick = () => {
    const t = state.token;
    state.token = null;
    ls.del('signedIn');
    if (t && window.google && google.accounts) google.accounts.oauth2.revoke(t, () => {});
    dlg.close();
    setStatus('ログアウトしました');
    showSignin(true);
  };

  /* ---------- 起動 ---------- */

  function start() {
    const root = { t: 'folder', id: state.rootId, name: ROOT_NAME };
    history.replaceState(root, '');
    render(root);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (!state.rootId) {
    setStatus('⚙ からフォルダを設定してください');
    openSettings();
  } else {
    start();
  }
})();
