/* =============================================================
 * LabIPA 3D Studio · Backend Integration (PRD v2.0)
 * - AuthModule: session di sessionStorage (JWT mock / SSO-ready),
 *   guest mode via POST /api/auth/guest, exchange via
 *   POST /api/auth/exchange. Redirect SSO aktif hanya bila
 *   window.LABIPA_SSO_BASE dikonfigurasi.
 * - StorageAdapter: single source of truth untuk persistensi
 *   layout. RemoteStore (fetch /api/layouts) + LocalCache
 *   (offline queue). Migrasi satu-kali dari kunci legacy
 *   'labipa.studio.v2' → backend, lalu kunci legacy dihapus.
 * - Live Edit: bendera dari GET /api/flags; peran dari session.
 * Modul ini non-breaking: tanpa session & tanpa API, game tetap
 * jalan seperti biasa (mode standalone).
 * ============================================================= */
(function () {
'use strict';

var LS_LEGACY_LAYOUT = 'labipa.studio.v2'; // kunci legacy, hanya dibaca saat migrasi
var LS_CACHE = 'labipa.cache.layout.v1';   // cache offline milik adapter
var LS_QUEUE = 'labipa.sync.queue.v1';
var LS_MIGRATED = 'labipa.migrated.v1';
var SS_SESSION = 'labipa.session';          // PRD v2: session di sessionStorage

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

/* ---------------- AuthModule (PRD v2 FR-05) ---------------- */
var AuthModule = {
  getSession: function () {
    try { return JSON.parse(ssGet(SS_SESSION) || 'null'); } catch (e) { return null; }
  },
  setSession: function (s) { ssSet(SS_SESSION, JSON.stringify(s)); },
  clear: function () { ssDel(SS_SESSION); },
  decode: function (jwt) {
    try {
      // Payload JWT = base64url (bukan base64 biasa) berisi UTF-8
      var b64 = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  },
  // Login SSO: redirect ke IdP bila dikonfigurasi, else fallback guest/dev-exchange
  login: function (opts) {
    opts = opts || {};
    var ssoBase = window.LABIPA_SSO_BASE || '';
    var code = null;
    try { code = new URLSearchParams(location.search).get('code'); } catch (e) {}
    if (!code && ssoBase) {
      var cid = window.LABIPA_CLIENT_ID || 'labipa-3d-studio';
      var redir = encodeURIComponent(location.origin + location.pathname);
      location.href = ssoBase + '/oauth/authorize?client_id=' + encodeURIComponent(cid) +
        '&redirect_uri=' + redir + '&response_type=code&scope=openid%20profile%20role';
      return Promise.resolve(null);
    }
    if (code) return AuthModule.exchange(code, opts);
    if (opts.guestName || (window.LABIPA_FLAGS && window.LABIPA_FLAGS.allowGuest)) {
      return AuthModule.guest(opts.guestName || 'Tamu', opts.classId || null);
    }
    return Promise.resolve(AuthModule.getSession());
  },
  guest: function (name, classId) {
    return fetch('/api/auth/guest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, classId: classId })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'guest login gagal');
      var s = { access_token: j.access_token, user: j.user };
      AuthModule.setSession(s);
      return s;
    });
  },
  exchange: function (code, opts) {
    return fetch('/api/auth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, name: opts && opts.name, classId: opts && opts.classId })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'exchange gagal');
      var s = { access_token: j.access_token, user: j.user };
      AuthModule.setSession(s);
      try {
        var u = new URL(location.href);
        u.searchParams.delete('code');
        history.replaceState(null, '', u.pathname + u.search);
      } catch (e) {}
      return s;
    });
  },
  logout: function () {
    AuthModule.clear();
    var ssoBase = window.LABIPA_SSO_BASE || '';
    if (ssoBase) location.href = ssoBase + '/logout';
    else location.reload();
  },
  authHeader: function () {
    var s = AuthModule.getSession();
    return s && s.access_token ? { Authorization: 'Bearer ' + s.access_token } : {};
  },
  isGuru: function () {
    var s = AuthModule.getSession();
    return !!(s && s.user && s.user.role === 'guru');
  }
};

/* ---------------- RemoteStore (PRD v2 FR-06) ---------------- */
function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, AuthModule.authHeader(), opts.headers || {});
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) {
        var e = new Error((j && j.error) || ('HTTP ' + r.status));
        e.status = r.status; e.body = j;
        throw e;
      }
      return j;
    });
  });
}

var RemoteStore = {
  online: true,
  list: function (params) {
    var q = params && params.classId ? '?classId=' + encodeURIComponent(params.classId) : '';
    return api('/api/layouts' + q).then(function (j) { RemoteStore.online = true; return j.items || []; })
      .catch(function (e) { RemoteStore.online = false; throw e; });
  },
  get: function (id) { return api('/api/layouts/' + encodeURIComponent(id)).then(function (j) { return j.item; }); },
  create: function (layout) {
    return api('/api/layouts', { method: 'POST', body: JSON.stringify(layout) }).then(function (j) { return j.item; });
  },
  update: function (id, version, patch) {
    return api('/api/layouts/' + encodeURIComponent(id), {
      method: 'PUT', body: JSON.stringify(Object.assign({ version: version }, patch))
    }).then(function (j) { return j.item; });
  },
  clone: function (id) {
    return api('/api/layouts/' + encodeURIComponent(id) + '/clone', { method: 'POST', body: '{}' })
      .then(function (j) { return j.item; });
  },
  publish: function (id, classId) {
    return api('/api/layouts/' + encodeURIComponent(id) + '/publish', {
      method: 'POST', body: JSON.stringify({ classId: classId })
    }).then(function (j) { return j.item; });
  }
};

/* ---------------- LocalCache: antrean offline (IndexedDB-lite) ----------------
 * PRD meminta IndexedDB; antrean kecil ini memakai localStorage agar
 * tetap jalan di semua WebView sekolah. Cache MURNI — bukan source of truth. */
var LocalCache = {
  queue: function () {
    try { return JSON.parse(lsGet(LS_QUEUE) || '[]'); } catch (e) { return []; }
  },
  // Tiap op membawa snapshot layout PENUH, jadi cukup simpan yang terbaru.
  // Kalau ditumpuk, tiap autosave selama offline jadi satu 'create' sendiri
  // → sekali online terbentuk puluhan layout kembar.
  enqueue: function (op) {
    lsSet(LS_QUEUE, JSON.stringify([Object.assign({ ts: Date.now() }, op)]));
  },
  peek: function () { return LocalCache.queue()[0] || null; },
  shift: function () {
    var q = LocalCache.queue();
    var op = q.shift();
    lsSet(LS_QUEUE, JSON.stringify(q));
    return op;
  },
  clear: function () { lsDel(LS_QUEUE); },
  cacheLayout: function (doc) { lsSet(LS_CACHE, JSON.stringify(doc)); },
  readCache: function () {
    try { return JSON.parse(lsGet(LS_CACHE) || 'null'); } catch (e) { return null; }
  }
};

/* ---------------- StorageAdapter (PRD v2 FR-06 §7.2) ---------------- */
var StorageAdapter = {
  currentId: null,
  currentVersion: null,
  // FR-3: scene belum dimuat setelah reload → antrean 'update' DITAHAN.
  // Kalau id dari antrean langsung diadopsi sementara scene masih kosong,
  // autosave berikutnya menimpa layout lama dengan scene kosong.
  _sceneReady: false,
  setSceneReady: function (v) { StorageAdapter._sceneReady = v !== false; },
  isSceneReady: function () { return !!StorageAdapter._sceneReady; },
  list: function () { return RemoteStore.list().catch(function () { return []; }); },
  get: function (id) {
    return RemoteStore.get(id).catch(function () {
      var c = LocalCache.readCache();
      return c && c.items ? { id: id, version: 0, items: c.items, offline: true } : null;
    });
  },
  // Simpan: POST bila belum punya id, PUT + optimistic lock bila sudah
  save: function (layout, opts) {
    var force = !!(opts && opts.force);
    var payload = { name: layout.name || 'Layout Lab', items: layout.items, classId: layout.classId };
    if (force) payload.force = true;
    // Scene berisi item = bukti scene sudah dimuat (bukan scene kosong
    // pasca-reload). Tandai siap agar flushQueue boleh mengadopsi id.
    if (payload.items && payload.items.length) StorageAdapter._sceneReady = true;
    if (!StorageAdapter.currentId) {
      return RemoteStore.create(payload).then(function (it) {
        StorageAdapter.currentId = it.id;
        StorageAdapter.currentVersion = it.version;
        LocalCache.clear(); // snapshot ini lebih baru dari apa pun yang masih antre
        return it;
      }).catch(function () {
        // Offline: antre + cache lokal + WAL IndexedDB (payload besar)
        LocalCache.enqueue({ op: 'create', payload: payload });
        LocalCache.cacheLayout({ items: payload.items, ts: Date.now() });
        try { WalDB.putLatest(payload.items); } catch (e) {}
        return { offline: true, items: payload.items };
      });
    }
    return RemoteStore.update(StorageAdapter.currentId, StorageAdapter.currentVersion, payload)
      .then(function (it) {
        StorageAdapter.currentVersion = it.version;
        LocalCache.clear();
        return it;
      }).catch(function (e) {
        if (e && e.status === 409) throw e; // conflict wajib ditangani UI (modal muat ulang)
        LocalCache.enqueue({ op: 'update', id: StorageAdapter.currentId, version: StorageAdapter.currentVersion, payload: payload });
        LocalCache.cacheLayout({ items: payload.items, ts: Date.now() });
        try { WalDB.putLatest(payload.items); } catch (e2) {}
        return { offline: true, items: payload.items };
      });
  },
  flushQueue: function () {
    // Dipanggil dari boot, event 'online', dan unlock gate → jangan jalan dobel
    if (StorageAdapter._flushing) return StorageAdapter._flushing;
    var out = [];
    function next() {
      // Op baru dibuang dari antrean SETELAH server menerimanya; kalau masih
      // offline ia tetap antre untuk dicoba lagi (dulu hilang begitu saja).
      var op = LocalCache.peek();
      if (!op) return Promise.resolve(out);
      // 'update' membawa id layout-nya sendiri (currentId kosong lagi setelah
      // reload); 'create' saat layout sudah ada = update, bukan layout baru.
      var needsAdopt = (op.op === 'update' && op.id) && !StorageAdapter.currentId;
      if (needsAdopt && !StorageAdapter._sceneReady) {
        // FR-3: scene belum dimuat — TAHAN antrean (jangan shift), coba lagi
        // pada flush berikutnya setelah scene siap. Kalau id diadopsi
        // sekarang, autosave berikut menimpa layout lama dengan scene kosong.
        out.push('deferred');
        return Promise.resolve(out);
      }
      var id = (op.op === 'update' && op.id) || StorageAdapter.currentId;
      var p;
      if (id) {
        var version = id === StorageAdapter.currentId ? StorageAdapter.currentVersion : op.version;
        p = RemoteStore.update(id, version, op.payload);
      } else if (op.op === 'create') p = RemoteStore.create(op.payload);
      else p = Promise.resolve(null);
      return p.then(function (it) {
        if (it && it.id) { StorageAdapter.currentId = it.id; StorageAdapter.currentVersion = it.version; }
        LocalCache.shift(); out.push(true); return next();
      }).catch(function (e) {
        out.push(false);
        // Ditolak server (409/4xx): diulang pun tetap ditolak → buang supaya
        // antrean tidak macet. Gagal jaringan/5xx: biarkan antre.
        if (e && e.status >= 400 && e.status < 500) { LocalCache.shift(); return next(); }
        return out;
      });
    }
    var done = function () { StorageAdapter._flushing = null; };
    StorageAdapter._flushing = next();
    StorageAdapter._flushing.then(done, done);
    return StorageAdapter._flushing;
  },
  // Migrasi satu-kali: localStorage legacy → backend, lalu hapus kunci legacy
  migrateIfNeeded: function (getItems) {
    if (lsGet(LS_MIGRATED)) return Promise.resolve(null);
    var raw = lsGet(LS_LEGACY_LAYOUT);
    if (!raw) { lsSet(LS_MIGRATED, '1'); return Promise.resolve(null); }
    var items = null;
    try { items = JSON.parse(raw).items || null; } catch (e) {}
    if (!items || !items.length) { lsDel(LS_LEGACY_LAYOUT); lsSet(LS_MIGRATED, '1'); return Promise.resolve(null); }
    var msg = 'Migrasi layout lama (' + items.length + ' item) ke akun Anda?';
    var ok = false;
    try { ok = window.confirm(msg); } catch (e) {}
    lsSet(LS_MIGRATED, '1');
    if (!ok) return Promise.resolve(null);
    return RemoteStore.create({ name: 'Layout migrasi', items: items }).then(function (it) {
      StorageAdapter.currentId = it.id;
      StorageAdapter.currentVersion = it.version;
      lsDel(LS_LEGACY_LAYOUT);
      return it;
    }).catch(function () {
      if (typeof getItems === 'function') { try { getItems(); } catch (e) {} }
      return null;
    });
  }
};

/* ---------------- Gate (PRD v4.0 FR-18/21/22) ----------------
 * Token di sessionStorage 'labipa.gate_token'. Idle >2 jam →
 * kunci sesi (tanpa reload, state utuh). Autosave & LabIPA lain
 * memeriksa isLocked() dan jeda saat terkunci. */
var GATE_TOKEN_KEY = 'labipa.gate_token';
var GATE_IDLE_MS = 2 * 3600 * 1000; // FR-21 default 2 jam
try {
  var gm = /[?&]gate_idle=(\d+)/.exec(location.search);
  if (gm) GATE_IDLE_MS = parseInt(gm[1], 10) * 60 * 1000;
} catch (e) {}
var gateExpiryTimer = null;
var gateIdleTimer = null;
function gateToken() { return ssGet(GATE_TOKEN_KEY); }
function gateTouchIdle() {
  if (gateIdleTimer) { try { clearTimeout(gateIdleTimer); } catch (e) {} }
  gateIdleTimer = setTimeout(function () { Gate.lock('idle'); }, GATE_IDLE_MS);
  window.LABIPA_GATE_LAST_ACTIVE = Date.now();
}
['mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
  try { document.addEventListener(ev, gateTouchIdle, { passive: true }); } catch (e) {}
});
var Gate = {
  required: function () {
    // Server /api/gate/status bilang wajib atau tidak; default wajib bila tak tahu
    if (window.LABIPA_GATE_REQUIRED === false) return false;
    return true;
  },
  token: gateToken,
  isLocked: function () {
    try {
      if (!Gate.required()) return false; // GATE_REQUIRED=false → tidak ada yang dikunci
      return window.LABIPA_GATE_LOCKED === true || !gateToken();
    } catch (e) { return true; }
  },
  check: function () {
    var t = gateToken();
    // Status SELALU ditanyakan, juga tanpa token: hanya server yang tahu gate
    // wajib atau tidak (tanpa ini GATE_REQUIRED=false tetap memunculkan overlay).
    return fetch('/api/gate/status', { headers: t ? { Authorization: 'Bearer ' + t } : {} })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (j && typeof j.required === 'boolean') window.LABIPA_GATE_REQUIRED = j.required;
        // Token ditolak server (kedaluwarsa/dicabut) → buang, agar isLocked() jujur
        if (t && j && j.unlocked === false) ssDel(GATE_TOKEN_KEY);
        return !!(j && j.unlocked);
      }).catch(function () { return !!t; }); // offline → anggap terkunci lunak? tidak: token ada = lanjut
  },
  unlock: function (key) {
    var k = String(key || '').toUpperCase().replace(/\s+/g, '');
    return fetch('/api/gate/unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var e = new Error((j && j.error) || ('HTTP ' + r.status));
          e.status = r.status; e.attemptsLeft = j && j.attemptsLeft; e.until = j && j.until;
          throw e;
        }
        return j;
      });
    }).then(function (j) {
      ssSet(GATE_TOKEN_KEY, j.token);
      try { window.LABIPA_GATE_LOCKED = false; } catch (e) {}
      if (gateExpiryTimer) { try { clearTimeout(gateExpiryTimer); } catch (e) {} }
      try { gateExpiryTimer = setTimeout(function () { Gate.lock('expired'); }, (j.expiresIn || 43200) * 1000); } catch (e) {}
      gateTouchIdle();
      try { document.dispatchEvent(new CustomEvent('labipa:gate-unlock')); } catch (e) {}
      return true;
    });
  },
  lock: function (reason) {
    if (!Gate.required()) return; // timer idle tetap jalan walau gate dimatikan
    var t = gateToken();
    if (t) {
      fetch('/api/gate/lock', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(function () {});
      ssDel(GATE_TOKEN_KEY);
    }
    try { window.LABIPA_GATE_LOCKED = true; } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('labipa:gate-lock', { detail: { reason: reason || 'manual' } })); } catch (e) {}
  },
  authHeader: function () {
    var t = gateToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }
};

/* ---------------- WAL IndexedDB (Sprint 5: payload >5MB, tutup jendela 2 dtk) ----------------
 * Antrean localStorage tetap untuk op kecil; snapshot layout besar ke IndexedDB. */
var WalDB = {
  db: null,
  open: function () {
    if (WalDB.db) return Promise.resolve(WalDB.db);
    return new Promise(function (res) {
      try {
        if (!('indexedDB' in window)) return res(null);
        var rq = indexedDB.open('labipa-wal', 2);
        rq.onupgradeneeded = function () {
          try {
            if (!rq.result.objectStoreNames.contains('ops')) rq.result.createObjectStore('ops');
            // v3.0 FR-11: store drafts keyPath sessionId
            if (!rq.result.objectStoreNames.contains('drafts')) rq.result.createObjectStore('drafts', { keyPath: 'sessionId' });
          } catch (e) {}
        };
        rq.onsuccess = function () { WalDB.db = rq.result; res(rq.result); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  },
  putLatest: function (items) {
    return WalDB.open().then(function (db) {
      if (!db) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction('ops', 'readwrite');
          tx.objectStore('ops').put({ items: items, ts: Date.now() }, 'latest');
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
        } catch (e) { res(false); }
      });
    });
  },
  readLatest: function () {
    return WalDB.open().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var rq = db.transaction('ops', 'readonly').objectStore('ops').get('latest');
          rq.onsuccess = function () { res(rq.result || null); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  },
  // v3.0 FR-11: draft per session {sessionId, assignmentId, items, lastModified, syncedAt, syncedVersion}
  draftPut: function (sessionId, doc) {
    try { WalDB.putLatest(doc.items); } catch (e) {}
    return WalDB.open().then(function (db) {
      if (!db) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({
            sessionId: sessionId, assignmentId: doc.assignmentId || null,
            items: doc.items, lastModified: Date.now(),
            syncedAt: doc.syncedAt || null, syncedVersion: doc.syncedVersion || null
          });
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
        } catch (e) { res(false); }
      });
    });
  },
  draftGet: function (sessionId) {
    return WalDB.open().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var rq = db.transaction('drafts', 'readonly').objectStore('drafts').get(sessionId);
          rq.onsuccess = function () { res(rq.result || null); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
};

/* ---------------- Deteksi 2 tab (Sprint 5 FR-42: tab kedua read-only) ---------------- */
var TAB_ID = 'tab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function tabHeartbeat() {
  try {
    var cur = null;
    try { cur = JSON.parse(localStorage.getItem('labipa.activetab') || 'null'); } catch (e) {}
    var mine = { id: TAB_ID, ts: Date.now() };
    if (!cur || cur.id === TAB_ID || Date.now() - cur.ts > 5000) {
      try { localStorage.setItem('labipa.activetab', JSON.stringify(mine)); } catch (e) {}
      if (window.LABIPA_SECOND_TAB) {
        window.LABIPA_SECOND_TAB = false;
        try { document.dispatchEvent(new CustomEvent('labipa:tab-role')); } catch (e) {}
      }
    } else {
      if (!window.LABIPA_SECOND_TAB) {
        window.LABIPA_SECOND_TAB = true;
        try { document.dispatchEvent(new CustomEvent('labipa:tab-role')); } catch (e) {}
      }
    }
  } catch (e) {}
}
try { setInterval(tabHeartbeat, 2000); tabHeartbeat(); } catch (e) {}
try { window.addEventListener('beforeunload', function () {
  try {
    var cur = JSON.parse(localStorage.getItem('labipa.activetab') || 'null');
    if (cur && cur.id === TAB_ID) localStorage.removeItem('labipa.activetab');
  } catch (e) {}
}); } catch (e) {}

/* ---------------- flags ---------------- */
function loadFlags() {
  return fetch('/api/flags').then(function (r) { return r.json(); }).then(function (j) {
    window.LABIPA_FLAGS = { allowGuest: !!(j && j.allowGuest), liveEdit: !!(j && j.liveEdit) };
    // Sprint 4: TURN dari env server → iceServers WebRTC (tanpa ubah kode)
    try {
      if (j && j.turn && j.turn.length && window.VOICE_CONFIG && window.VOICE_CONFIG.iceServers) {
        j.turn.forEach(function (t) {
          var exists = window.VOICE_CONFIG.iceServers.some(function (x) { return x.urls === t.urls; });
          if (!exists) window.VOICE_CONFIG.iceServers.push(t);
        });
      }
    } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('labipa:flags', { detail: window.LABIPA_FLAGS })); } catch (e) {}
    return window.LABIPA_FLAGS;
  }).catch(function () {
    window.LABIPA_FLAGS = { allowGuest: true, liveEdit: true };
    return window.LABIPA_FLAGS;
  });
}

window.LabIPA = {
  Auth: AuthModule,
  Gate: Gate,
  Wal: WalDB,
  Storage: StorageAdapter,
  Remote: RemoteStore,
  Cache: LocalCache,
  flags: loadFlags,
  // Mode penonton Live Edit: siswa di room kelas saat guru live
  isViewer: function () {
    try {
      var s = AuthModule.getSession();
      if (!s || !s.user) return false;
      if (s.user.role !== 'siswa') return false;
      return !!(window.LABIPA_LIVE && window.LABIPA_FLAGS && window.LABIPA_FLAGS.liveEdit);
    } catch (e) { return false; }
  }
};
loadFlags();
})();
