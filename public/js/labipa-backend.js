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
    try { return JSON.parse(atob(String(jwt).split('.')[1])); } catch (e) { return null; }
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
  enqueue: function (op) {
    var q = LocalCache.queue();
    q.push(Object.assign({ ts: Date.now() }, op));
    lsSet(LS_QUEUE, JSON.stringify(q.slice(-50)));
  },
  shift: function () {
    var q = LocalCache.queue();
    var op = q.shift();
    lsSet(LS_QUEUE, JSON.stringify(q));
    return op;
  },
  cacheLayout: function (doc) { lsSet(LS_CACHE, JSON.stringify(doc)); },
  readCache: function () {
    try { return JSON.parse(lsGet(LS_CACHE) || 'null'); } catch (e) { return null; }
  }
};

/* ---------------- StorageAdapter (PRD v2 FR-06 §7.2) ---------------- */
var StorageAdapter = {
  currentId: null,
  currentVersion: null,
  list: function () { return RemoteStore.list().catch(function () { return []; }); },
  get: function (id) {
    return RemoteStore.get(id).catch(function () {
      var c = LocalCache.readCache();
      return c && c.items ? { id: id, version: 0, items: c.items, offline: true } : null;
    });
  },
  // Simpan: POST bila belum punya id, PUT + optimistic lock bila sudah
  save: function (layout) {
    var payload = { name: layout.name || 'Layout Lab', items: layout.items, classId: layout.classId };
    if (!StorageAdapter.currentId) {
      return RemoteStore.create(payload).then(function (it) {
        StorageAdapter.currentId = it.id;
        StorageAdapter.currentVersion = it.version;
        return it;
      }).catch(function () {
        // Offline: antre + cache lokal
        LocalCache.enqueue({ op: 'create', payload: payload });
        LocalCache.cacheLayout({ items: payload.items, ts: Date.now() });
        return { offline: true, items: payload.items };
      });
    }
    return RemoteStore.update(StorageAdapter.currentId, StorageAdapter.currentVersion, payload)
      .then(function (it) {
        StorageAdapter.currentVersion = it.version;
        return it;
      }).catch(function (e) {
        if (e && e.status === 409) throw e; // conflict wajib ditangani UI (modal muat ulang)
        LocalCache.enqueue({ op: 'update', id: StorageAdapter.currentId, payload: payload });
        LocalCache.cacheLayout({ items: payload.items, ts: Date.now() });
        return { offline: true, items: payload.items };
      });
  },
  flushQueue: function () {
    var out = [];
    var op = LocalCache.shift();
    function next() {
      if (!op) return Promise.resolve(out);
      var p;
      if (op.op === 'create') p = RemoteStore.create(op.payload);
      else if (op.op === 'update' && StorageAdapter.currentId) {
        p = RemoteStore.update(StorageAdapter.currentId, StorageAdapter.currentVersion, op.payload);
      } else p = Promise.resolve(null);
      return p.then(function (it) {
        if (it && it.id) { StorageAdapter.currentId = it.id; StorageAdapter.currentVersion = it.version; }
        out.push(true); op = LocalCache.shift(); return next();
      }).catch(function () { out.push(false); op = null; return out; });
    }
    return next();
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

/* ---------------- flags ---------------- */
function loadFlags() {
  return fetch('/api/flags').then(function (r) { return r.json(); }).then(function (j) {
    window.LABIPA_FLAGS = { allowGuest: !!(j && j.allowGuest), liveEdit: !!(j && j.liveEdit) };
    try { document.dispatchEvent(new CustomEvent('labipa:flags', { detail: window.LABIPA_FLAGS })); } catch (e) {}
    return window.LABIPA_FLAGS;
  }).catch(function () {
    window.LABIPA_FLAGS = { allowGuest: true, liveEdit: true };
    return window.LABIPA_FLAGS;
  });
}

window.LabIPA = {
  Auth: AuthModule,
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
