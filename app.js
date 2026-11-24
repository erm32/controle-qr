/* Contrôle de l'éclairage de sécurité : application hors ligne. Les saisies sont gardées sur le téléphone puis envoyées en lot à Apps Script. */
(function () {
  'use strict';
  var CFG = window.CQR || {};
  var API = CFG.API || '';
  var MONTH = CFG.MONTHLY_DAYS || 30, YEAR = CFG.ANNUAL_DAYS || 365;
  var KEY = 'cqr.v1', SCHEMA = 2;
  var VERSION = 'v9 (sans QR, réf bloc, télécommandes)';
  var OKR = 'OK', BAD = 'À remplacer';
  var DEFECTS = ['À remplacer', 'Batterie à changer', 'Défaut alimentation', 'Défaut télécommande'];
  var DEFKEY = { BAD: 'À remplacer', BATT: 'Batterie à changer', ALIM: 'Défaut alimentation', TEL: 'Défaut télécommande' };
  var RESOL = { batterie: { from: 'Batterie à changer', label: 'Batterie changée', btn: 'Batterie changée' }, alim: { from: 'Défaut alimentation', label: 'Alimentation réparée', btn: 'Alim réparée' }, telecommande: { from: 'Défaut télécommande', label: 'Télécommande réparée', btn: 'Télécommande réparée' } };
  function isDef(e) { return DEFECTS.indexOf(e.res) !== -1; }

  /* ---------- Outils ---------- */
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(n) { return ('0' + n).slice(-2); }
  function fmtDate(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysSince(iso) { if (!iso) return null; var t = Date.parse(iso); return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 864e5)); }
  function plural(n, a, b) { return n + ' ' + (n > 1 ? b : a); }
  function toast(t) { var el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('show'); }, 2200); }
  function iso(ts) { return new Date(ts).toISOString(); }
  function cmpNum(a, b) { return String(a).localeCompare(String(b), 'fr', { numeric: true }); }
  function etageKey(s) {
    s = String(s).trim().toLowerCase();
    if (/^(rdc|rez)/.test(s)) return 0;
    if (/^(ss|sous|-)/.test(s)) { var m0 = /\d+/.exec(s); return m0 ? -Number(m0[0]) : -1; }
    var m = /^\d+/.exec(s); return m ? Number(m[0]) : 1000;
  }
  function cmpEtage(a, b) { return etageKey(a) - etageKey(b) || cmpNum(a, b); }

  /* ---------- État conservé sur le téléphone ---------- */
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  var S = load();
  S.outbox = S.outbox || []; S.rejected = S.rejected || []; S.sticky = S.sticky || {};
  if (S.schema !== SCHEMA) {   // ancienne version (QR codes) : données incompatibles, on repart du serveur
    S.server = null;
    S.outbox = S.outbox.filter(function (op) { return !('qr' in op) && !('oldQr' in op); });
    S.schema = SCHEMA;
  }
  var storageWarned = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { if (!storageWarned) { storageWarned = true; toast('Stockage du téléphone plein ou bloqué'); } }
  }

  var tab = '', M = null, VIEW = null, syncing = false, netFail = false, authMsg = '';
  var F = { q: '', zone: '', etat: '' };
  var TREE = {};
  function niv() { return S.me ? S.me.niv : ''; }
  function isN1() { return niv() === '1'; }

  /* ---------- Données affichées = dernières données du serveur + saisies en attente ---------- */
  function findE(d, id) { return d.byId[id] || null; }
  function pushHist(e, ts, text) {
    e.h = (e.h || []).concat([iso(ts).slice(0, 10) + ' | ' + text + ' | ' + (S.me ? S.me.nom : '')]).slice(-30);
  }
  function applyLocal(d, op) {
    var e, i;
    if (op.type === 'controle') {
      e = findE(d, op.eid); if (!e) return;
      var rs0 = DEFECTS.indexOf(op.result) !== -1 ? op.result : (isN1() ? BAD : OKR);
      if (rs0 !== OKR) pushHist(e, op.ts, rs0);
      if (!e.dc || op.ts >= Date.parse(e.dc)) { e.dc = iso(op.ts); e.res = rs0; }
      if (op.comment && !isN1()) e.cq = op.comment;
    } else if (op.type === 'resolution') {
      e = findE(d, op.eid); var rz = RESOL[op.kind];
      if (e && rz && e.res === rz.from) { pushHist(e, op.ts, rz.label); e.dc = iso(op.ts); e.res = OKR; if (op.comment) e.cq = op.comment; }
    } else if (op.type === 'commentaire') {
      e = findE(d, op.eid); if (e) e.cq = op.comment;
    } else if (op.type === 'creation') {
      e = { id: op.eid, site: op.site, bat: op.bat, etage: op.etage, ref: op.ref, lc: op.lc || '', type: op.mat, dc: '', res: '', dr: '', cq: '', zone: op.zone || '', h: [], tel: op.tel || '' };
      d.emp.push(e); d.byId[e.id] = e;
    } else if (op.type === 'remplacement') {
      e = findE(d, op.eid); if (!e) return;
      if (op.ref) e.ref = op.ref;
      if (op.mat) e.type = op.mat;
      e.dr = e.dc = iso(op.ts); e.res = OKR; e.cq = ''; e.h = [];
    } else if (op.type === 'modifier') {
      e = findE(d, op.eid); if (!e) return;
      e.site = op.site || e.site; e.bat = op.bat; e.etage = op.etage; e.ref = op.ref; e.lc = op.lc || ''; e.type = op.mat; e.zone = op.zone || '';
      if (op.tel !== undefined) e.tel = op.tel;
      if (op.reset) { e.dc = ''; e.res = ''; e.dr = ''; e.cq = ''; e.h = []; }
    } else if (op.type === 'zone') {
      e = findE(d, op.eid); if (e) e.zone = op.zone;
    } else if (op.type === 'zoneok') {
      d.emp.forEach(function (x) { if (x.site === op.site && x.zone === op.zone && !isDef(x)) { x.dc = iso(op.ts); x.res = OKR; } });
    } else if (op.type === 'telcreation') {
      if (!d.tel.some(function (t) { return t.nom.toLowerCase() === String(op.nom).toLowerCase(); })) d.tel.push({ nom: op.nom, site: op.site, dr: '', com: '' });
    } else if (op.type === 'telremp') {
      d.tel.forEach(function (t) { if (t.nom.toLowerCase() === String(op.nom).toLowerCase()) { t.dr = (op.date || today()) + 'T12:00:00.000Z'; t.com = op.comment || ''; } });
    } else if (op.type === 'mensuel' || op.type === 'annuel') {
      for (i = 0; i < d.sites.length; i++) if (d.sites[i].site === op.site) {
        var s = d.sites[i], k = op.type === 'mensuel' ? ['dm', 'mpar', 'mcom'] : ['da', 'apar', 'acom'];
        if (!s[k[0]] || op.ts >= Date.parse(s[k[0]])) { s[k[0]] = iso(op.ts); s[k[1]] = op.nom; s[k[2]] = op.comment || ''; }
      }
    }
  }

  function view() {
    if (VIEW) return VIEW;
    var d = S.server ? JSON.parse(JSON.stringify(S.server)) : { sites: [], emp: [], tel: [] };
    d.tel = d.tel || [];
    d.emp.forEach(function (e) { e.ref = e.ref || e.qr || ''; e.tel = e.tel || ''; });
    d.byId = {};
    d.emp.forEach(function (e) { d.byId[e.id] = e; });
    S.outbox.forEach(function (op) { try { applyLocal(d, op); } catch (e) {} });
    VIEW = d;
    return d;
  }
  function sig() { var d = view(); return JSON.stringify([d.sites, d.emp, d.tel, S.rejected.length]); }
  function sites() { return view().sites.map(function (s) { return s.site; }); }
  function curSite() { var l = sites(); return l.indexOf(S.site) !== -1 ? S.site : (l[0] || ''); }
  function siteObj(name) { return view().sites.filter(function (s) { return s.site === name; })[0] || {}; }
  function empOf(site) { return view().emp.filter(function (e) { return e.site === site; }); }
  function telsOf(site) { return view().tel.filter(function (t) { return t.site === site; }).sort(function (a, b) { return cmpNum(a.nom, b.nom); }); }
  function telObj(nom) { return view().tel.filter(function (t) { return t.nom === nom; })[0] || null; }
  function zonesOf(site) {
    var z = {}; empOf(site).forEach(function (e) { if (e.zone) z[e.zone] = 1; });
    return Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }
  function zoneCount(site, z) { return empOf(site).filter(function (e) { return e.zone === z; }).length; }
  function typesAll() {
    var z = {}; view().emp.forEach(function (e) { if (e.type) z[e.type] = 1; });
    return Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }
  function stateOf(e) {
    if (isDef(e)) return { c: 'bad', t: e.res };
    if (!e.dc) return { c: 'none', t: 'Jamais contrôlé' };
    var d = daysSince(e.dc);
    if (d !== null && d > YEAR) return { c: 'warn', t: 'OK · ancien' };
    return { c: 'ok', t: 'OK' };
  }
  function pill(e) { var s = stateOf(e); return '<span class="pill ' + s.c + '">' + s.t + '</span>'; }
  function nom(e) { return e.ref || e.type || '—'; }
  function cmpRef(a, b) { return cmpNum(a.ref, b.ref); }

  /* ---------- File d'attente et envoi ---------- */
  function enqueue(op) {
    op.id = uid(); op.ts = Date.now();
    S.outbox.push(op); VIEW = null; save(); render(); scheduleSync(2000);
  }
  var syncTimer = 0;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(function () { sync(); }, ms); }

  function api(body) {
    return fetch(API, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  function sync(manual) {
    if (syncing || !S.code) return Promise.resolve();
    if (!API || /COLLEZ/.test(API)) { authMsg = 'Adresse du serveur non renseignée (fichier config.js).'; render(); return Promise.resolve(); }
    syncing = true; renderHeader();
    var sent = S.outbox.slice(0, 150);
    return api({ code: S.code, ops: sent }).then(function (r) {
      syncing = false; netFail = false;
      if (!r.ok) {
        if (/incorrect/i.test(r.error)) { forget(); authMsg = 'Code refusé : ' + r.error; }
        else if (manual) toast(r.error);
        render(); return;
      }
      var res = {}; (r.results || []).forEach(function (x) { res[x.id] = x; });
      var keep = [];
      S.outbox.forEach(function (op) {
        var x = res[op.id];
        if (!x) keep.push(op);
        else if (!x.ok) S.rejected.push({ op: op, error: x.error, at: Date.now(), name: opName(op) });
      });
      var before = sig();
      S.outbox = keep; S.server = r.data; S.me = r.me; S.last = r.now; VIEW = null; save();
      if (sig() !== before || !$('#view').innerHTML) render(); else renderHeader();   // pas de redessin inutile : un appui en cours ne se perd pas
      if (S.outbox.length) scheduleSync(500);
      else if (manual) toast('Synchronisé');
    }).catch(function () {
      syncing = false; netFail = true; renderHeader();
      if (manual) toast('Pas de réseau : les saisies restent sur ce téléphone');
    });
  }

  function forget() { S.code = ''; S.me = null; S.server = null; VIEW = null; M = null; save(); }

  /* ---------- Connexion ---------- */
  function login(code) {
    if (!API || /COLLEZ/.test(API)) { authMsg = 'Adresse du serveur non renseignée (fichier config.js).'; return render(); }
    authMsg = ''; syncing = true; render();
    api({ code: code }).then(function (r) {
      syncing = false;
      if (!r.ok) { authMsg = r.error; return render(); }
      S.code = code; S.me = r.me; S.server = r.data; S.last = r.now; VIEW = null;
      tab = ''; save(); render(); sync();
    }).catch(function () { syncing = false; authMsg = 'Connexion impossible : première connexion, il faut du réseau.'; render(); });
  }

  /* ---------- Rendu général ---------- */
  function tabsFor() {
    if (isN1()) return [['home', 'Accueil'], ['list', 'Signaler un défaut']];
    return [['list', 'Liste'], ['zones', 'Zones'], ['home', 'Site'], ['dash', 'Tous les sites'], ['tel', 'Télécommandes'], ['report', 'Rapport']];
  }

  function render() {
    if (!S.code || !S.me) { $('#tabs').innerHTML = ''; renderHeader(); renderLogin(); return; }
    if (!tab || !tabsFor().some(function (t) { return t[0] === tab; })) tab = isN1() ? 'home' : 'list';
    renderHeader(); renderTabs();
    var v = $('#view'), h = banners();
    if (tab === 'home') h += homeView();
    else if (tab === 'dash') h += dashView();
    else if (tab === 'zones') h += zonesView();
    else if (tab === 'list') h += listView();
    else if (tab === 'tel') h += telView();
    else if (tab === 'report') h += reportView();
    var keepFocus = document.activeElement && document.activeElement.id;
    var keepVal = keepFocus ? document.activeElement.value : null;
    v.innerHTML = h;
    if (keepFocus && keepVal !== null && $('#' + keepFocus)) { var el = $('#' + keepFocus); try { el.focus(); if (el.setSelectionRange) el.setSelectionRange(keepVal.length, keepVal.length); } catch (e) {} }
    renderModal();
  }

  function renderHeader() {
    var h = '<div class="brand">Éclairage de sécurité</div>';
    if (S.me) {
      var n = S.outbox.length, b;
      if (syncing) b = ['pend', 'Synchronisation…'];
      else if (!navigator.onLine || netFail) b = ['off', 'Hors ligne' + (n ? ' · ' + n + ' en attente' : '')];
      else if (n) b = ['pend', n + ' en attente'];
      else b = ['ok', 'Synchronisé' + (S.last ? ' ' + hhmm(S.last) : '')];
      h += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">' +
        '<button class="chip sync ' + b[0] + '" data-act="sync">' + esc(b[1]) + '</button>' +
        '<span class="chip">' + esc(S.me.nom) + ' · ' + (niv() === 'admin' ? 'Admin' : 'Niveau ' + niv()) + '</span>' +
        '<button class="ghost" data-act="quit">Quitter</button></div>';
    }
    $('#hdr').innerHTML = h;
  }
  function renderTabs() {
    $('#tabs').innerHTML = tabsFor().map(function (t) {
      return '<button role="tab" data-act="tab" data-v="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>';
    }).join('');
  }
  function banners() {
    var h = '';
    if (S.rejected.length) h += '<div class="banner">' + plural(S.rejected.length, 'opération refusée', 'opérations refusées') + ' par le serveur. <button class="ghost" data-act="rej">Voir</button></div>';
    return h;
  }
  function siteSelect(withAll) {
    var l = sites();
    if (l.length < 2 && !withAll) return '';
    var cur = withAll && S.site === '*' ? '*' : curSite();
    return '<div class="bar"><select class="in" data-act="site" aria-label="Site">' +
      (withAll ? '<option value="*"' + (cur === '*' ? ' selected' : '') + '>Tous les sites</option>' : '') +
      l.map(function (s) { return '<option' + (s === cur ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></div>';
  }

  function renderLogin() {
    $('#view').innerHTML = '<div class="card" style="margin-top:24px"><h1>Connexion</h1><div class="muted" style="font-size:13px">Version ' + VERSION + '</div>' +
      '<p class="muted" style="margin:8px 0 0">Saisissez votre code personnel. Il reste mémorisé sur ce téléphone jusqu’à « Quitter » : l’application fonctionne ensuite sans réseau.</p>' +
      '<label class="lab" for="code">Code</label><input class="in" id="code" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false"' + (syncing ? ' disabled' : '') + '>' +
      (authMsg ? '<div class="err" role="alert">' + esc(authMsg) + '</div>' : '') +
      '<button class="btn" data-act="login"' + (syncing ? ' disabled' : '') + '>' + (syncing ? 'Vérification…' : 'Valider') + '</button></div>' +
      (S.outbox.length ? '<p class="muted" style="margin-top:12px">' + plural(S.outbox.length, 'saisie en attente', 'saisies en attente') + ' sur ce téléphone : elles seront envoyées après connexion.</p>' : '');
    $('#modal').hidden = true;
  }

  /* ---------- Compteurs et tableau de bord du site ---------- */
  function counter(title, iso, limit, by, com) {
    var d = daysSince(iso), cls, big, sub;
    if (d === null) { cls = 'bad'; big = 'Jamais'; sub = 'Aucun contrôle enregistré'; }
    else {
      cls = d > limit ? 'bad' : (d > limit * 0.8 ? 'warn' : 'ok');
      big = d === 0 ? 'Aujourd’hui' : plural(d, 'jour', 'jours');
      sub = 'Le ' + fmtDate(iso) + (by ? ' par ' + esc(by) : '') + (d > limit ? ' · en retard de ' + plural(d - limit, 'jour', 'jours') : ' · échéance dans ' + plural(limit - d, 'jour', 'jours'));
    }
    return '<div class="counter ' + cls + '"><div class="t">' + title + '</div><div class="n">' + big + '</div><div class="s">' + sub + '</div>' +
      (com ? '<div class="s">« ' + esc(com) + ' »</div>' : '') + '</div>';
  }

  function homeView() {
    var site = curSite(), so = siteObj(site), list = empOf(site);
    var nOk = 0, nBad = 0, nNone = 0;
    list.forEach(function (e) { if (isDef(e)) nBad++; else if (!e.dc) nNone++; else nOk++; });
    var h = siteSelect() + '<h2 style="margin:4px 2px 10px">' + esc(site || 'Aucun site') + '</h2>';
    h += counter('Dernier contrôle mensuel', so.dm, MONTH, so.mpar, so.mcom);
    if (!isN1()) h += '<div style="height:10px"></div>' + counter('Dernier contrôle annuel', so.da, YEAR, so.apar, so.acom);
    h += '<div class="stats"><div class="stat"><b>' + list.length + '</b><span>Blocs</span></div><div class="stat"><b style="color:var(--ok)">' + nOk + '</b><span>OK</span></div>' +
      '<div class="stat"><b style="color:var(--bad)">' + nBad + '</b><span>En défaut</span></div><div class="stat"><b>' + nNone + '</b><span>Jamais contrôlés</span></div></div>';
    if (isN1()) h += '<button class="btn" data-act="monthly" ' + (site ? '' : 'disabled') + '>Contrôle mensuel fait</button>';
    else h += '<button class="btn" data-act="annual" ' + (site ? '' : 'disabled') + '>Contrôle annuel terminé</button>';
    var bad = list.filter(isDef).sort(cmpRef);
    h += '<div class="group">En défaut (' + bad.length + ')</div>';
    h += bad.length ? '<div class="list">' + bad.map(rowHtml).join('') + '</div>' : '<div class="card muted">Aucun bloc en défaut.</div>';
    return h;
  }

  function rowHtml(e) {
    return '<button class="item' + (isDef(e) ? ' def' : '') + '" data-act="emp" data-v="' + esc(e.id) + '"><span class="l"><span class="n rf">' + esc(nom(e)) + '</span><br><span class="s">' +
      esc(e.type) + (e.zone ? ' · zone ' + esc(e.zone) : '') + (e.tel ? ' · télécommande ' + esc(e.tel) : '') +
      (e.cq ? '<br>« ' + esc(e.cq) + ' »' : '') + '</span></span>' + pill(e) + '</button>';
  }

  /* ---------- Tableau de bord général ---------- */
  function ind(iso, limit) {
    var d = daysSince(iso);
    if (d === null) return '<span class="pill bad">Jamais</span>';
    var c = d > limit ? 'bad' : (d > limit * 0.8 ? 'warn' : 'ok');
    return '<span class="pill ' + c + '">' + (d === 0 ? 'Aujourd’hui' : 'il y a ' + d + ' j') + '</span> <span class="muted" style="font-size:13px">' + fmtDate(iso) + '</span>';
  }
  function lateness(iso, limit) { var d = daysSince(iso); return d === null ? 1e9 : d - limit; }
  function dashView() {
    var rows = view().sites.map(function (so) {
      var l = empOf(so.site), bad = 0, none = 0;
      l.forEach(function (e) { if (isDef(e)) bad++; else if (!e.dc) none++; });
      return { so: so, n: l.length, bad: bad, none: none, ok: l.length - bad - none, late: Math.max(lateness(so.dm, MONTH), lateness(so.da, YEAR)) };
    }).sort(function (a, b) { return b.late - a.late; });
    var nm = rows.filter(function (r) { return lateness(r.so.dm, MONTH) > 0; }).length, na = rows.filter(function (r) { return lateness(r.so.da, YEAR) > 0; }).length;
    var h = '<h2 style="margin:4px 2px 4px">Tous les sites</h2><p class="muted" style="margin:0 2px 12px">' + plural(rows.length, 'site', 'sites') + ' · ' + plural(nm, 'mensuel en retard', 'mensuels en retard') + ' · ' + plural(na, 'annuel en retard', 'annuels en retard') + '. Les plus en retard sont en premier.</p>';
    if (!rows.length) return h + '<div class="card muted">Aucun site.</div>';
    h += '<div class="list">' + rows.map(function (r) {
      return '<button class="item' + (r.bad ? ' def' : '') + '" data-act="gosite" data-v="' + esc(r.so.site) + '" style="align-items:flex-start"><span class="l"><span class="n">' + esc(r.so.site) + '</span><br>' +
        '<span class="s">Mensuel : </span>' + ind(r.so.dm, MONTH) + (r.so.mpar ? ' <span class="s">' + esc(r.so.mpar) + '</span>' : '') + '<br>' +
        '<span class="s">Annuel : </span>' + ind(r.so.da, YEAR) + (r.so.apar ? ' <span class="s">' + esc(r.so.apar) + '</span>' : '') + '</span>' +
        '<span style="text-align:right"><span class="pill ' + (r.bad ? 'bad' : 'ok') + '">' + r.bad + ' en défaut</span><br><span class="s">' + r.n + ' blocs · ' + r.none + ' non contrôlés</span></span></button>';
    }).join('') + '</div>';
    return h;
  }

  /* ---------- Zones ---------- */
  var ZN = null;
  function zonesView() {
    if (ZN) return zoneDetail();
    var site = curSite(), list = empOf(site), h = siteSelect();
    var z = {};
    list.forEach(function (e) { var k = e.zone || ''; var o = z[k] || (z[k] = { n: 0, ok: 0, bad: 0, none: 0 }); o.n++; if (isDef(e)) o.bad++; else if (!e.dc) o.none++; else o.ok++; });
    var names = Object.keys(z).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
    h += '<p class="muted" style="margin:2px 2px 10px">Touchez une zone pour voir tous ses blocs (vert = OK, rouge = non conforme) et la valider d’un coup.</p>';
    if (!names.length) h += '<div class="card muted">Aucune zone définie pour ce site. Indiquez une zone en créant un bloc, ou depuis sa fiche (« Modifier la fiche »).</div>';
    h += '<div class="list">' + names.map(function (n) {
      var o = z[n];
      return '<button class="item' + (o.bad ? ' def' : '') + '" data-act="zopen" data-v="' + esc(n) + '"><span class="l"><span class="n">' + esc(n) + '</span><br><span class="s">' + plural(o.n, 'bloc', 'blocs') + '</span></span>' +
        '<span style="text-align:right"><span class="pill ok">' + o.ok + ' OK</span> <span class="pill bad">' + o.bad + ' en défaut</span> <span class="pill none">' + o.none + ' à contrôler</span></span></button>';
    }).join('') + '</div>';
    if (z['']) h += '<p class="muted" style="margin:12px 2px">' + plural(z[''].n, 'bloc sans zone', 'blocs sans zone') + ' (voir l’onglet Liste).</p>';
    return h;
  }
  function zoneDetail() {
    var l = empOf(ZN.site).filter(function (e) { return e.zone === ZN.zone; }).sort(cmpRef);
    var bad = l.filter(isDef).length, ok = l.filter(function (e) { return !isDef(e) && e.dc; }).length, none = l.length - bad - ok, todo = l.length - bad;
    var h = '<button class="ghost" data-act="zback">‹ Toutes les zones</button><h2 style="margin:0 2px 4px">Zone « ' + esc(ZN.zone) + ' »</h2>' +
      '<p class="muted" style="margin:0 2px 10px">' + esc(ZN.site) + ' · ' + plural(l.length, 'bloc', 'blocs') + '</p>' +
      '<div class="stats"><div class="stat"><b>' + l.length + '</b><span>Blocs</span></div><div class="stat"><b style="color:var(--ok)">' + ok + '</b><span>OK</span></div>' +
      '<div class="stat"><b style="color:var(--bad)">' + bad + '</b><span>Non conformes</span></div><div class="stat"><b>' + none + '</b><span>À contrôler</span></div></div>' +
      '<button class="btn ok" data-act="zoneok" data-v="' + esc(ZN.zone) + '"' + (todo ? '' : ' disabled') + '>OK pour toute la zone' + (bad ? ' (sauf ' + bad + ' non conforme' + (bad > 1 ? 's' : '') + ')' : '') + '</button>' +
      '<div class="tiles">' + l.map(function (e) {
        var c = isDef(e) ? 'bad' : (e.dc ? 'ok' : 'none');
        function ln(k, v) { return '<div class="ln"><span class="k">' + k + '</span><span class="v">' + (v ? esc(v) : '&nbsp;') + '</span></div>'; }
        return '<button class="tile ' + c + '" data-act="emp" data-v="' + esc(e.id) + '"><b class="q">' + esc(nom(e)) + '</b>' +
          ln('État', isDef(e) ? e.res : (e.dc ? 'OK' : 'À contrôler')) + ln('Bâtiment', e.bat) + ln('Étage', e.etage) + ln('Type', e.type) + ln('Télécommande', e.tel) +
          ln('Commentaire de lieu', e.lc) + ln('Dernier contrôle', fmtDate(e.dc)) + ln('Dernier remplacement', fmtDate(e.dr)) + ln('Commentaire', e.cq) + '</button>';
      }).join('') + '</div>';
    return h;
  }

  /* ---------- Liste : arborescence site > bâtiment > étage > blocs ---------- */
  function listView() {
    var site = curSite(), list = empOf(site), zs = zonesOf(site);
    var q = F.q.trim().toLowerCase(), filtering = !!(q || F.zone || F.etat);
    var items = list.filter(function (e) {
      if (F.zone === '__none' ? e.zone : (F.zone && e.zone !== F.zone)) return false;
      if (F.etat === 'bad' && !isDef(e)) return false;
      if (F.etat === 'none' && (e.dc || isDef(e))) return false;
      if (F.etat === 'ok' && (isDef(e) || !e.dc)) return false;
      return !q || [e.ref, e.lc, e.bat, e.etage, e.type, e.zone, e.tel, e.cq].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var h = siteSelect() + '<div class="bar"><input class="in" id="fq" type="search" placeholder="Rechercher…" value="' + esc(F.q) + '">' +
      '<select class="in" data-act="fzone" aria-label="Zone"><option value="">Toutes les zones</option><option value="__none"' + (F.zone === '__none' ? ' selected' : '') + '>Sans zone</option>' +
      zs.map(function (z) { return '<option' + (F.zone === z ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('') + '</select>' +
      '<select class="in" data-act="fetat" aria-label="État"><option value="">Tous les états</option>' +
      [['ok', 'OK'], ['bad', 'En défaut'], ['none', 'Jamais contrôlés']].map(function (o) { return '<option value="' + o[0] + '"' + (F.etat === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    if (!isN1()) h += '<button class="btn sm" data-act="newbloc" style="margin:0 0 10px"' + (site ? '' : ' disabled') + '>+ Ajouter un bloc</button>';
    h += '<div class="treehead"><span class="tsite">' + esc(site || 'Aucun site') + '</span><span class="muted"> · ' + plural(items.length, 'bloc', 'blocs') + '</span></div>';
    if (!items.length) return h + '<div class="card muted">Aucun bloc.' + (isN1() ? '' : ' Utilisez « Ajouter un bloc ».') + '</div>';
    var bats = {};
    items.forEach(function (e) { var b = bats[e.bat] || (bats[e.bat] = {}); (b[e.etage] || (b[e.etage] = [])).push(e); });
    function cnt(arr) { var bad = arr.filter(isDef).length; return plural(arr.length, 'bloc', 'blocs') + (bad ? ' · <b class="rd">' + bad + ' en défaut</b>' : ''); }
    Object.keys(bats).sort(cmpNum).forEach(function (bat) {
      var all = []; Object.keys(bats[bat]).forEach(function (et) { all = all.concat(bats[bat][et]); });
      var kb = 'b|' + bat;
      h += '<details class="tb" data-k="' + esc(kb) + '"' + (filtering || TREE[kb] !== false ? ' open' : '') + '><summary><span class="tn">Bâtiment ' + esc(bat) + '</span><span class="tc">' + cnt(all) + '</span></summary>';
      Object.keys(bats[bat]).sort(cmpEtage).forEach(function (et) {
        var arr = bats[bat][et].sort(cmpRef), ke = 'e|' + bat + '|' + et;
        h += '<details class="te" data-k="' + esc(ke) + '"' + (filtering || TREE[ke] !== false ? ' open' : '') + '><summary><span class="tn">Étage ' + esc(et) + '</span><span class="tc">' + cnt(arr) + '</span></summary>' +
          '<div class="list">' + arr.map(rowHtml).join('') + '</div>' +
          (isN1() ? '' : '<button class="ghost" data-act="newin" data-bat="' + esc(bat) + '" data-etage="' + esc(et) + '">+ ajouter un bloc à cet étage</button>') + '</details>';
      });
      h += '</details>';
    });
    return h;
  }

  /* ---------- Télécommandes ---------- */
  function telView() {
    var site = curSite(), l = telsOf(site), emps = empOf(site);
    var h = siteSelect() + '<h2 style="margin:4px 2px 4px">Télécommandes · ' + esc(site) + '</h2>' +
      '<p class="muted" style="margin:0 2px 10px">Une télécommande appartient à un seul site et peut commander plusieurs blocs.</p>' +
      '<button class="btn sm" data-act="telnew" style="margin:0 0 10px"' + (site ? '' : ' disabled') + '>+ Nouvelle télécommande</button>';
    var sans = emps.filter(function (e) { return !e.tel; }).length;
    if (!l.length) return h + '<div class="card muted">Aucune télécommande sur ce site.</div>';
    h += '<div class="list">' + l.map(function (t) {
      var bl = emps.filter(function (e) { return e.tel === t.nom; }).sort(cmpRef);
      var late = daysSince(t.dr);
      return '<div class="item" style="align-items:flex-start"><span class="l"><span class="n rf">' + esc(t.nom) + '</span><br>' +
        '<span class="s">' + plural(bl.length, 'bloc', 'blocs') + (bl.length ? ' : ' + esc(bl.map(function (e) { return e.ref; }).join(', ')) : '') + '</span><br>' +
        '<span class="s">Dernier remplacement : <b>' + (t.dr ? fmtDate(t.dr) : 'non renseigné') + '</b>' + (late !== null ? ' (il y a ' + plural(late, 'jour', 'jours') + ')' : '') + '</span>' +
        (t.com ? '<br><span class="s">« ' + esc(t.com) + ' »</span>' : '') + '</span>' +
        '<button class="btn sm sec" data-act="telremp" data-v="' + esc(t.nom) + '">Remplacée…</button></div>';
    }).join('') + '</div>';
    if (sans) h += '<p class="muted" style="margin:12px 2px">' + plural(sans, 'bloc sans télécommande', 'blocs sans télécommande') + '.</p>';
    return h;
  }

  /* ---------- Rapport ---------- */
  function histText(e) {
    return histVisible(e).map(function (x) { var p = x.split(' | '); return fmtDate(p[0]) + ' ' + (p[1] || '') + (p[2] ? ' (' + p[2] + ')' : ''); }).join(' ; ');
  }
  function etatText(e) { return isDef(e) ? e.res : (!e.dc ? 'Jamais contrôlé' : (daysSince(e.dc) > YEAR ? 'OK (ancien)' : 'OK')); }
  function telText(e) { var t = e.tel && telObj(e.tel); return e.tel ? e.tel + (t && t.dr ? ' (remplacée le ' + fmtDate(t.dr) + ')' : '') : ''; }
  function cmpTree(a, b) { return cmpNum(a.bat, b.bat) || cmpEtage(a.etage, b.etage) || cmpRef(a, b); }

  function reportView() {
    var all = S.site === '*', site = curSite(), h = siteSelect(true), now = new Date();
    var head = '<div class="bar noprint"><button class="btn sm" data-act="print">Imprimer / PDF</button><button class="btn sm sec" data-act="csv">Exporter (tableur)</button></div>';
    var meta = 'Édité le ' + fmtDate(now.toISOString()) + ' à ' + hhmm(now.toISOString()) + ' · données synchronisées le ' + (S.last ? fmtDate(S.last) + ' à ' + hhmm(S.last) : 'jamais') +
      (S.outbox.length ? ' · ' + plural(S.outbox.length, 'saisie en attente d’envoi', 'saisies en attente d’envoi') + ' (comprises)' : '');
    if (all) {
      var rows = view().sites.map(function (s) {
        var l = empOf(s.site), bad = l.filter(isDef).length, none = l.filter(function (e) { return !e.dc && !isDef(e); }).length;
        var lr = l.map(function (e) { return e.dr; }).filter(Boolean).sort().pop();
        return '<tr><td>' + esc(s.site) + '</td><td>' + l.length + '</td><td>' + (l.length - bad - none) + '</td><td>' + bad + '</td><td>' + none + '</td><td>' + (fmtDate(s.dm) || '—') + '</td><td>' + (fmtDate(s.da) || '—') + '</td><td>' + (fmtDate(lr) || '—') + '</td></tr>';
      }).join('');
      return h + head + '<div class="card rep"><h1>Tableau de bord : tous les sites</h1><div class="meta">' + meta + '</div><div class="tablewrap"><table><thead><tr><th>Site</th><th>Blocs</th><th>OK</th><th>En défaut</th><th>Jamais contrôlés</th><th>Dernier mensuel</th><th>Dernier annuel</th><th>Dernier remplacement</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }
    var so = siteObj(site), l = empOf(site).sort(cmpTree);
    var bad = l.filter(isDef).length, none = l.filter(function (e) { return !e.dc && !isDef(e); }).length;
    var tr = l.map(function (e) {
      return '<tr' + (isDef(e) ? ' class="def"' : '') + '><td>' + esc(e.bat) + '</td><td>' + esc(e.etage) + '</td><td class="rf">' + esc(e.ref) + '</td><td>' + esc(e.zone) + '</td><td>' + esc(e.type) + '</td><td>' + esc(telText(e)) + '</td><td>' +
        (fmtDate(e.dc) || '—') + '</td><td>' + esc(etatText(e)) + '</td><td class="nc">' + (isDef(e) ? esc(e.res) : '') + '</td><td>' + (fmtDate(e.dr) || '—') + '</td><td>' + esc(e.cq) + '</td><td>' + esc(histText(e)) + '</td></tr>';
    }).join('');
    var tt = telsOf(site).map(function (t) {
      return '<tr><td class="rf">' + esc(t.nom) + '</td><td>' + l.filter(function (e) { return e.tel === t.nom; }).length + '</td><td>' + (fmtDate(t.dr) || '—') + '</td><td>' + esc(t.com) + '</td></tr>';
    }).join('');
    return h + head + '<div class="card rep"><h1>' + esc(site) + '</h1><div class="meta">' + meta + '</div>' +
      '<p>Contrôle mensuel : <b>' + (fmtDate(so.dm) || 'jamais') + '</b>' + (so.mpar ? ' par ' + esc(so.mpar) : '') + ' · Contrôle annuel : <b>' + (fmtDate(so.da) || 'jamais') + '</b>' + (so.apar ? ' par ' + esc(so.apar) : '') +
      '<br>' + plural(l.length, 'bloc', 'blocs') + ' · ' + (l.length - bad - none) + ' OK · <b>' + bad + ' en défaut</b> · ' + none + ' jamais contrôlés</p>' + defBreak(l) +
      '<div class="tablewrap"><table><thead><tr><th>Bâtiment</th><th>Étage</th><th>Réf bloc</th><th>Zone</th><th>Type</th><th>Télécommande</th><th>Dernier contrôle</th><th>État</th><th>Non-conformité</th><th>Dernier remplacement</th><th>Commentaire</th><th>Historique depuis le dernier remplacement</th></tr></thead><tbody>' + tr + '</tbody></table></div>' +
      (tt ? '<h3 style="margin:16px 0 6px">Télécommandes</h3><div class="tablewrap"><table><thead><tr><th>Télécommande</th><th>Blocs</th><th>Dernier remplacement</th><th>Commentaire</th></tr></thead><tbody>' + tt + '</tbody></table></div>' : '') + '</div>';
  }

  function defBreak(l) {
    var c = {}; l.forEach(function (e) { if (isDef(e)) c[e.res] = (c[e.res] || 0) + 1; });
    var k = Object.keys(c); if (!k.length) return '';
    return '<p>' + k.map(function (x) { return esc(x) + ' : <b>' + c[x] + '</b>'; }).join(' · ') + '</p>';
  }
  function exportCsv() {
    var site = curSite(), all = S.site === '*';
    var cols = ['Site', 'Bâtiment', 'Étage', 'Réf bloc', 'Zone', 'Type', 'Télécommande', 'Remplacement télécommande', 'Dernier contrôle', 'État', 'Non-conformité', 'Dernier remplacement', 'Commentaire', 'Commentaire de lieu', 'Historique depuis le dernier remplacement'];
    var lines = [cols.join(';')];
    (all ? view().emp : empOf(site)).slice().sort(function (a, b) { return a.site.localeCompare(b.site, 'fr') || cmpTree(a, b); }).forEach(function (e) {
      var t = e.tel && telObj(e.tel);
      lines.push([e.site, e.bat, e.etage, e.ref, e.zone, e.type, e.tel, t ? fmtDate(t.dr) : '', fmtDate(e.dc), etatText(e), isDef(e) ? e.res : '', fmtDate(e.dr), e.cq, e.lc, histText(e)].map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'controle-' + (all ? 'tous-sites' : site.replace(/[^\w-]+/g, '_')) + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- Fenêtres du bas ---------- */
  var shownM = null;
  function openModal(m) { M = m; renderModal(true); }
  function closeModal() { M = null; renderModal(); }

  function lnm(k, v) { return '<div class="ln"><span class="k">' + k + '</span><span class="v">' + (v ? esc(v) : '&nbsp;') + '</span></div>'; }
  function empInfo(e) {
    var st = stateOf(e), t = e.tel && telObj(e.tel);
    return '<h2 class="rfbig">' + esc(nom(e)) + '</h2>' +
      '<div class="fiche">' + lnm('Site', e.site) + lnm('Bâtiment', e.bat) + lnm('Étage', e.etage) + lnm('Type', e.type) +
      lnm('Zone', e.zone ? e.zone + ' (' + plural(zoneCount(e.site, e.zone), 'bloc', 'blocs') + ')' : '') +
      lnm('Télécommande', e.tel ? e.tel + (t && t.dr ? ' · remplacée le ' + fmtDate(t.dr) : '') : '') + lnm('Commentaire de lieu', e.lc) + '</div>' +
      '<div style="margin-top:8px"><span class="pill ' + st.c + '">' + st.t + '</span> <span class="muted" style="font-size:14px">' + (e.dc ? 'contrôlé le ' + fmtDate(e.dc) : '') + (e.dr ? ' · remplacé le ' + fmtDate(e.dr) : '') + '</span></div>' + histHtml(e);
  }
  function resolBtns(e) {
    var k = Object.keys(RESOL).filter(function (k) { return RESOL[k].from === e.res; })[0];
    return k ? '<button class="btn ok" data-act="resol" data-v="' + k + '">✔ ' + RESOL[k].btn + '</button>' : '<p class="muted" style="margin:10px 0 0">Ce bloc est à remplacer : le statut reste jusqu’au remplacement (bouton ci-dessous).</p>';
  }
  // Historique affiché : un défaut corrigé disparaît, seule la réparation reste.
  function histVisible(e) {
    var lst = (e.h || []).slice();
    Object.keys(RESOL).forEach(function (k) {
      var r = RESOL[k];
      for (var i = 0; i < lst.length; i++) {
        if ((lst[i].split(' | ')[1] || '') !== r.label) continue;
        for (var j = i - 1; j >= 0; j--) if ((lst[j].split(' | ')[1] || '') === r.from) { lst.splice(j, 1); i--; break; }
      }
    });
    return lst;
  }
  function histHtml(e) {
    var hv = histVisible(e);
    if (!hv.length) return '';
    return '<div class="group" style="padding:12px 0 4px">Historique depuis le dernier remplacement</div><ul style="margin:0;padding-left:18px;font-size:14px">' + hv.map(function (x) {
      var p = x.split(' | '); return '<li>' + esc(fmtDate(p[0])) + ' : ' + esc(p[1] || '') + (p[2] ? ' <span class="muted">(' + esc(p[2]) + ')</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function defBtns(e) {
    return Object.keys(DEFKEY).filter(function (k) { return DEFKEY[k] !== e.res; }).map(function (k) {
      return '<button class="btn bad" data-act="ctl" data-v="' + k + '" style="font-size:16px">' + DEFKEY[k] + '</button>';
    }).join('');
  }

  // Zone et télécommande : listes propres au site choisi
  function szFields(site, zoneCur, telCur) {
    var zs = zonesOf(site), ts = telsOf(site);
    return '<label class="lab" for="m-zone">Zone</label><select class="in" id="m-zone" data-act="zonesel"><option value="">— aucune —</option>' +
      zs.map(function (z) { return '<option value="' + esc(z) + '"' + (z === zoneCur ? ' selected' : '') + '>' + esc(z) + ' (' + zoneCount(site, z) + ')</option>'; }).join('') + '<option value="__new">+ Nouvelle zone…</option></select>' +
      '<input class="in" id="m-zone-new" placeholder="Nom de la nouvelle zone" maxlength="60" style="margin-top:8px" hidden>' +
      '<label class="lab" for="m-tel">Télécommande</label><select class="in" id="m-tel" data-act="telsel"><option value="">— aucune —</option>' +
      ts.map(function (t) { return '<option value="' + esc(t.nom) + '"' + (t.nom === telCur ? ' selected' : '') + '>' + esc(t.nom) + '</option>'; }).join('') + '<option value="__new">+ Nouvelle télécommande…</option></select>' +
      '<input class="in" id="m-tel-new" placeholder="Nom de la nouvelle télécommande" maxlength="60" style="margin-top:8px" hidden>';
  }
  function readZone() {
    var s = $('#m-zone'); if (!s) return '';
    return s.value === '__new' ? ($('#m-zone-new').value || '').trim() : s.value;
  }
  // Télécommande choisie : { name, create } ou { err }
  function readTel(site) {
    var s = $('#m-tel'); if (!s) return { name: '' };
    if (s.value !== '__new') return { name: s.value };
    var n = ($('#m-tel-new').value || '').trim();
    if (!n) return { err: 'Saisissez le nom de la nouvelle télécommande.' };
    var ex = view().tel.filter(function (t) { return t.nom.toLowerCase() === n.toLowerCase(); })[0];
    if (ex) return ex.site === site ? { name: ex.nom } : { err: 'La télécommande « ' + ex.nom + ' » existe déjà sur le site ' + ex.site + '.' };
    return { name: n, create: true };
  }
  function refTaken(site, ref, exceptId) {
    var k = ref.toLowerCase();
    return empOf(site).some(function (e) { return e.id !== exceptId && e.ref.toLowerCase() === k; });
  }
  function fiche(e, mode) {
    var st = S.sticky, sl = sites(), site = e ? e.site : (sl.indexOf(M.site || st.site) !== -1 ? (M.site || st.site) : curSite());
    var bat = e ? e.bat : (M.bat || st.bat || ''), etage = e ? e.etage : (M.etage || st.etage || '');
    return '<label class="lab" for="m-site">Site</label><select class="in" id="m-site" data-act="msite">' + sl.map(function (s) { return '<option' + (s === site ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
      '<div class="row2"><div><label class="lab" for="m-bat">Bâtiment</label><input class="in" id="m-bat" maxlength="60" value="' + esc(bat) + '"></div>' +
      '<div><label class="lab" for="m-etage">Étage</label><input class="in" id="m-etage" maxlength="20" value="' + esc(etage) + '"></div></div>' +
      '<label class="lab" for="m-ref">Réf bloc</label><input class="in" id="m-ref" maxlength="60" value="' + esc(e ? e.ref : '') + '" placeholder="Ex. B12">' +
      '<label class="lab" for="m-mat">Type de matériel</label><input class="in" id="m-mat" list="types" maxlength="60" value="' + esc(e ? e.type : (st.mat || '')) + '"><datalist id="types">' + typesAll().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
      '<label class="lab" for="m-lc">Commentaire de lieu</label><input class="in" id="m-lc" maxlength="300" value="' + esc(e ? e.lc : '') + '" placeholder="Ex. hall, couloir nord…">' +
      '<div id="m-sz">' + szFields(site, e ? e.zone : (st.zone || ''), e ? e.tel : '') + '</div>';
  }

  function renderModal(force) {
    var el = $('#modal');
    if (!M || !S.me) { shownM = null; el.hidden = true; el.innerHTML = ''; return; }
    if (!force && shownM === M && !el.hidden) return;   // ne pas reconstruire une fenêtre ouverte (texte saisi, boutons)
    shownM = M;
    var d = view(), h = '', e = M.id ? d.byId[M.id] : null;
    if (M.k === 'ctl' && e) {
      h = empInfo(e) + '<label class="lab" for="m-com">Commentaire</label><textarea class="in" id="m-com" rows="2" maxlength="300" placeholder="Facultatif">' + esc(e.cq) + '</textarea>' +
        (isDef(e) ? resolBtns(e) : '<button class="btn ok" data-act="ctl" data-v="OK">OK</button>') +
        '<div class="group" style="padding:12px 0 0">Signaler un défaut</div><div class="defs">' + defBtns(e) + '</div>' +
        '<div class="row2"><button class="btn sec" data-act="repl">Remplacer le bloc</button><button class="btn sec" data-act="edit">Modifier la fiche</button></div>' +
        '<button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'defect' && e) {
      h = empInfo(e) + (isDef(e) ? '<p class="muted" style="margin:10px 0 0">Déjà signalé : ' + esc(e.res) + '.</p>' : '') +
        '<div class="group" style="padding:12px 0 0">Signaler un défaut</div><div class="defs">' + defBtns(e) + '</div><button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'new') {
      h = '<h2>Ajouter un bloc</h2>' + fiche(null) + '<div class="err" id="m-err" role="alert"></div>' +
        '<button class="btn" data-act="newgo">Créer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'edit' && e) {
      h = '<h2>Modifier la fiche</h2>' + fiche(e) +
        '<label style="display:flex;gap:10px;align-items:center;margin-top:14px"><input type="checkbox" id="m-reset" style="width:22px;height:22px"> Réemploi : autre matériel ou autre endroit, remettre le contrôle à zéro</label>' +
        '<div class="err" id="m-err" role="alert"></div><button class="btn" data-act="editgo">Enregistrer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'repl' && e) {
      h = '<h2>Remplacer le bloc</h2><div class="muted">Actuellement : ' + esc(nom(e)) + ' · ' + esc(e.type) + '</div>' +
        '<label class="lab" for="m-ref">Réf du nouveau bloc</label><input class="in" id="m-ref" maxlength="60" value="' + esc(e.ref) + '">' +
        '<label class="lab" for="m-mat">Type du nouveau matériel</label><input class="in" id="m-mat" list="types" maxlength="60" value="' + esc(e.type) + '"><datalist id="types">' + typesAll().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
        '<p class="muted" style="margin:10px 0 0">Le bâtiment, l’étage, la zone et la télécommande sont conservés. L’état passe à « OK » à la date du jour et l’historique repart à zéro.</p>' +
        '<div class="err" id="m-err" role="alert"></div><button class="btn" data-act="replgo">Confirmer le remplacement</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'telnew') {
      h = '<h2>Nouvelle télécommande</h2><div class="muted">' + esc(M.site) + '</div>' +
        '<label class="lab" for="m-nom">Nom / numéro</label><input class="in" id="m-nom" maxlength="60" placeholder="Ex. TC-01">' +
        '<div class="err" id="m-err" role="alert"></div><button class="btn" data-act="telnewgo">Créer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'telremp') {
      var t = telObj(M.nom) || {};
      h = '<h2>Télécommande « ' + esc(M.nom) + ' » remplacée</h2><div class="muted">Dernier remplacement enregistré : ' + (t.dr ? fmtDate(t.dr) : 'aucun') + '</div>' +
        '<label class="lab" for="m-date">Date du remplacement</label><input class="in" id="m-date" type="date" value="' + today() + '" max="' + today() + '">' +
        '<label class="lab" for="m-com">Commentaire</label><input class="in" id="m-com" maxlength="200" placeholder="Facultatif">' +
        '<div class="err" id="m-err" role="alert"></div><button class="btn" data-act="telrempgo">Enregistrer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'monthly' || M.k === 'annual') {
      var mo = M.k === 'monthly';
      h = '<h2>' + (mo ? 'Contrôle mensuel fait' : 'Contrôle annuel terminé') + '</h2><div class="muted">' + esc(M.site) + '</div>' +
        '<label class="lab" for="m-nom">Votre nom</label><input class="in" id="m-nom" maxlength="60" autocomplete="name" value="' + esc(mo ? (S.nom || '') : (S.nom || S.me.nom)) + '">' +
        '<label class="lab" for="m-com">Commentaire</label><textarea class="in" id="m-com" rows="3" maxlength="300" placeholder="Facultatif"></textarea><div class="err" id="m-err" role="alert"></div>' +
        '<button class="btn" data-act="mago">Valider</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'zoneok') {
      var l = empOf(M.site).filter(function (x) { return x.zone === M.zone; }), bad = l.filter(isDef).length, okn = l.length - bad;
      h = '<h2>Valider la zone « ' + esc(M.zone) + ' »</h2><p style="font-size:18px">Voulez-vous valider les <b>' + plural(okn, 'bloc', 'blocs') + '</b> de la zone « OK » à la date d’aujourd’hui' +
        (bad ? ', <b>sauf ' + plural(bad, 'bloc', 'blocs') + '</b> en défaut (' + plural(bad, 'garde', 'gardent') + ' leur statut : à remplacer, batterie, alimentation ou télécommande)' : '') + ' ?</p>' +
        '<p class="muted" style="margin:0">La zone compte ' + plural(l.length, 'bloc', 'blocs') + ' au total.</p>' +
        '<label class="lab" for="m-com">Commentaire</label><input class="in" id="m-com" maxlength="200" placeholder="Facultatif">' +
        '<button class="btn ok" data-act="zogo"' + (okn ? '' : ' disabled') + '>Oui, valider ' + plural(okn, 'bloc', 'blocs') + '</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'rej') {
      h = '<h2>Opérations refusées</h2><p class="muted">Le serveur a refusé ces opérations. Elles ne seront pas renvoyées.</p><div class="list">' + S.rejected.map(function (r) {
        return '<div class="item"><span class="l"><span class="n">' + esc(r.name || opName(r.op)) + '</span><br><span class="s">' + esc(r.error) + '</span></span></div>';
      }).join('') + '</div><button class="btn" data-act="rejclear">Effacer la liste</button><button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'quit') {
      h = '<h2>Quitter ?</h2><p>' + plural(S.outbox.length, 'saisie n’est pas encore envoyée', 'saisies ne sont pas encore envoyées') + '. Elles restent sur ce téléphone et partiront à la prochaine connexion, mais seront enregistrées sous le nom du prochain utilisateur.</p>' +
        '<button class="btn sec" data-act="sync">Envoyer maintenant</button><button class="btn bad" data-act="quitgo">Quitter quand même</button><button class="btn sec" data-act="close">Rester</button>';
    } else if (M.k === 'msg') {
      h = '<h2>' + esc(M.t) + '</h2><p>' + esc(M.m) + '</p><button class="btn" data-act="close">Fermer</button>';
    } else { M = null; shownM = null; el.hidden = true; return; }
    el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + h + '</div>';
    el.hidden = false;
  }
  function opName(op) {
    var n = { controle: 'Contrôle', commentaire: 'Commentaire', creation: 'Création', remplacement: 'Remplacement', zone: 'Changement de zone', resolution: 'Acquittement', modifier: 'Modification de fiche', zoneok: 'OK de zone', mensuel: 'Contrôle mensuel', annuel: 'Contrôle annuel', telcreation: 'Nouvelle télécommande', telremp: 'Remplacement de télécommande' }[op.type] || op.type;
    var e = op.eid && S.server && S.server.emp.filter(function (x) { return x.id === op.eid; })[0];
    return n + ' ' + (op.ref || (e && (e.ref || e.qr)) || op.nom || op.site || '') + ' (' + fmtDate(iso(op.ts)) + ')';
  }

  /* ---------- Actions ---------- */
  function val(id) { var e = $('#' + id); return e ? e.value.trim() : ''; }
  function setErr(t) { var e = $('#m-err'); if (e) e.textContent = t; }

  // Valide le formulaire de fiche ; renvoie null (erreur affichée) ou les champs
  function readFiche(exceptId) {
    var f = { site: val('m-site'), bat: val('m-bat'), etage: val('m-etage'), ref: val('m-ref'), lc: val('m-lc'), mat: val('m-mat'), zone: readZone() };
    if (!f.site || !f.ref || !f.bat || !f.etage || !f.mat) { setErr('Réf bloc, bâtiment, étage et type sont obligatoires.'); return null; }
    if ($('#m-zone') && $('#m-zone').value === '__new' && !f.zone) { setErr('Saisissez le nom de la nouvelle zone.'); return null; }
    if (refTaken(f.site, f.ref, exceptId)) { setErr('La réf « ' + f.ref + ' » existe déjà sur ce site.'); return null; }
    var t = readTel(f.site);
    if (t.err) { setErr(t.err); return null; }
    f.tel = t.name; f.telCreate = !!t.create;
    return f;
  }

  var ACT = {
    login: function () { login(val('code')); },
    sync: function () { if (M && M.k === 'quit') M = null; sync(true); renderModal(); },
    quit: function () { if (S.outbox.length) openModal({ k: 'quit' }); else { forget(); render(); } },
    quitgo: function () { forget(); M = null; render(); },
    zopen: function (el) { ZN = { site: curSite(), zone: el.getAttribute('data-v') }; render(); },
    zback: function () { ZN = null; render(); },
    gosite: function (el) { S.site = el.getAttribute('data-v'); save(); tab = 'home'; render(); },
    tab: function (el) { tab = el.getAttribute('data-v'); ZN = null; render(); },
    site: function (el) { S.site = el.value; ZN = null; save(); render(); },
    fzone: function (el) { F.zone = el.value; render(); },
    fetat: function (el) { F.etat = el.value; render(); },
    emp: function (el) { openModal({ k: isN1() ? 'defect' : 'ctl', id: el.getAttribute('data-v') }); },
    close: function () { closeModal(); },
    ctl: function (el) {
      var e = view().byId[M.id], k = el.getAttribute('data-v'), res = k === 'OK' ? OKR : DEFKEY[k];
      var op = { type: 'controle', eid: e.id, result: res };
      if (!isN1()) op.comment = val('m-com');
      var label = nom(e); closeModal(); enqueue(op); toast(res + ' : ' + label);
    },
    resol: function (el) {
      var e = view().byId[M.id], k = el.getAttribute('data-v'), op = { type: 'resolution', eid: e.id, kind: k, comment: val('m-com') };
      var label = nom(e); closeModal(); enqueue(op); toast(RESOL[k].label + ' : ' + label);
    },
    zonesel: function (el) { var n = $('#m-zone-new'); if (n) { n.hidden = el.value !== '__new'; if (!n.hidden) n.focus(); } },
    telsel: function (el) { var n = $('#m-tel-new'); if (n) { n.hidden = el.value !== '__new'; if (!n.hidden) n.focus(); } },
    msite: function (el) {   // le site change : zones et télécommandes proposées changent aussi
      var box = $('#m-sz'); if (box) box.innerHTML = szFields(el.value, '', '');
    },
    newbloc: function () { openModal({ k: 'new' }); },
    newin: function (el) { openModal({ k: 'new', site: curSite(), bat: el.getAttribute('data-bat'), etage: el.getAttribute('data-etage') }); },
    newgo: function () {
      var f = readFiche(''); if (!f) return;
      S.sticky = { site: f.site, bat: f.bat, etage: f.etage, mat: f.mat, zone: f.zone }; S.site = f.site;
      closeModal();
      if (f.telCreate) enqueue({ type: 'telcreation', nom: f.tel, site: f.site });
      enqueue({ type: 'creation', eid: 'E-' + uid(), site: f.site, bat: f.bat, etage: f.etage, ref: f.ref, lc: f.lc, mat: f.mat, zone: f.zone, tel: f.tel });
      toast('Bloc créé : ' + f.ref);
    },
    edit: function () { openModal({ k: 'edit', id: M.id }); },
    editgo: function () {
      var e = view().byId[M.id], f = readFiche(e.id); if (!f) return;
      var rs = $('#m-reset') && $('#m-reset').checked;
      closeModal();
      if (f.telCreate) enqueue({ type: 'telcreation', nom: f.tel, site: f.site });
      enqueue({ type: 'modifier', eid: e.id, site: f.site, bat: f.bat, etage: f.etage, ref: f.ref, lc: f.lc, mat: f.mat, zone: f.zone, tel: f.tel, reset: !!rs });
      toast('Fiche modifiée : ' + f.ref);
    },
    repl: function () { openModal({ k: 'repl', id: M.id }); },
    replgo: function () {
      var e = view().byId[M.id], ref = val('m-ref'), mat = val('m-mat');
      if (!ref || !mat) return setErr('Réf et type sont obligatoires.');
      if (ref.toLowerCase() !== e.ref.toLowerCase() && refTaken(e.site, ref, e.id)) return setErr('La réf « ' + ref + ' » existe déjà sur ce site.');
      closeModal(); enqueue({ type: 'remplacement', eid: e.id, ref: ref, mat: mat }); toast('Remplacé : ' + ref);
    },
    telnew: function () { openModal({ k: 'telnew', site: curSite() }); },
    telnewgo: function () {
      var n = val('m-nom'); if (!n) return setErr('Saisissez un nom.');
      var ex = view().tel.filter(function (t) { return t.nom.toLowerCase() === n.toLowerCase(); })[0];
      if (ex) return setErr(ex.site === M.site ? 'Cette télécommande existe déjà.' : 'Cette télécommande existe déjà sur le site ' + ex.site + '.');
      var site = M.site; closeModal(); enqueue({ type: 'telcreation', nom: n, site: site }); toast('Télécommande créée : ' + n);
    },
    telremp: function (el) { openModal({ k: 'telremp', nom: el.getAttribute('data-v') }); },
    telrempgo: function () {
      var dt = val('m-date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return setErr('Indiquez la date.');
      var op = { type: 'telremp', nom: M.nom, date: dt, comment: val('m-com') }; closeModal(); enqueue(op); toast('Remplacement enregistré : ' + op.nom);
    },
    monthly: function () { openModal({ k: 'monthly', site: curSite() }); },
    annual: function () { openModal({ k: 'annual', site: curSite() }); },
    mago: function () {
      var nom = val('m-nom'); if (nom.length < 2) return setErr('Indiquez votre nom.');
      var op = { type: M.k === 'monthly' ? 'mensuel' : 'annuel', site: M.site, nom: nom, comment: val('m-com') };
      var mo2 = M.k === 'monthly'; S.nom = nom; closeModal(); enqueue(op); toast(mo2 ? 'Contrôle mensuel enregistré' : 'Contrôle annuel enregistré');
    },
    zoneok: function (el) { openModal({ k: 'zoneok', site: curSite(), zone: el.getAttribute('data-v') }); },
    zogo: function () {
      var op = { type: 'zoneok', site: M.site, zone: M.zone, comment: val('m-com') }; closeModal(); enqueue(op); toast('Zone validée : ' + op.zone);
    },
    rej: function () { openModal({ k: 'rej' }); },
    rejclear: function () { S.rejected = []; save(); closeModal(); render(); },
    print: function () { window.print(); },
    csv: exportCsv
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
    if (el.disabled) return;
    var f = ACT[el.getAttribute('data-act')]; if (f) f(el);
  });
  document.addEventListener('change', function (e) {
    var el = e.target, a = el.getAttribute && el.getAttribute('data-act');
    if (a && el.tagName === 'SELECT' && ACT[a]) ACT[a](el);
  });
  document.addEventListener('input', function (e) { if (e.target.id === 'fq') { F.q = e.target.value; render(); } });
  document.addEventListener('toggle', function (e) { var t = e.target, k = t.getAttribute && t.getAttribute('data-k'); if (k) TREE[k] = t.open; }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'code') ACT.login(); });

  window.addEventListener('online', function () { netFail = false; renderHeader(); sync(); });
  window.addEventListener('offline', function () { renderHeader(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.me) { renderHeader(); sync(); } });
  setInterval(function () { if (S.me && navigator.onLine) { if (S.outbox.length || Date.now() - Date.parse(S.last || 0) > 600000) sync(); } }, 60000);

  /* ---------- Démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  save();
  render();
  if (S.code && S.me) sync();
  window.__cqr = { S: function () { return S; }, view: view, sync: sync };
})();
