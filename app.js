/* Contrôle de l'éclairage de sécurité : application hors ligne. Les fiches sont gardées sur le téléphone puis envoyées en lot à Apps Script. */
(function () {
  'use strict';
  var CFG = window.CQR || {};
  var API = CFG.API || '';
  var MONTH = CFG.MONTHLY_DAYS || 30, YEAR = CFG.ANNUAL_DAYS || 365;
  var KEY = 'cqr.v1';
  var VERSION = 'v6 (zones, non-conformités, étiquettes)';
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
  function daysSince(iso) { if (!iso) return null; var t = Date.parse(iso); return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 864e5)); }
  function plural(n, a, b) { return n + ' ' + (n > 1 ? b : a); }
  function toast(t) { var el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('show'); }, 2200); }
  function baseUrl() { return location.origin + location.pathname.replace(/[^\/]*$/, ''); }

  /* ---------- État conservé sur le téléphone ---------- */
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  var S = load();
  S.outbox = S.outbox || []; S.rejected = S.rejected || []; S.sticky = S.sticky || {};
  var storageWarned = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { if (!storageWarned) { storageWarned = true; toast('Stockage du téléphone plein ou bloqué'); } }
  }

  var tab = '', M = null, R = null, VIEW = null, syncing = false, netFail = false, authMsg = '';
  var F = { q: '', zone: '', etat: '' };
  var lastQr = '', lastAt = 0;
  var urlQr = (/[?&]q=(Q-\d{4,5})/i.exec(location.search) || [])[1] || '';

  function niv() { return S.me ? S.me.niv : ''; }
  function isN1() { return niv() === '1'; }

  /* ---------- Données affichées = dernières données du serveur + fiches en attente ---------- */
  function findQr(d, qr) { for (var i = 0; i < d.emp.length; i++) if (d.emp[i].qr === qr) return d.emp[i]; return null; }
  function iso(ts) { return new Date(ts).toISOString(); }

  function pushHist(e, ts, text) {
    e.h = (e.h || []).concat([iso(ts).slice(0, 10) + ' | ' + text + ' | ' + (S.me ? S.me.nom : '')]).slice(-30);
  }
  function applyLocal(d, op) {
    var e, i;
    if (op.type === 'controle') {
      e = findQr(d, op.qr); if (!e) return;
      var rs0 = DEFECTS.indexOf(op.result) !== -1 ? op.result : (/rempl/i.test(op.result) ? BAD : (isN1() ? BAD : OKR));
      if (rs0 !== OKR) pushHist(e, op.ts, rs0);
      if (!e.dc || op.ts >= Date.parse(e.dc)) { e.dc = iso(op.ts); e.res = rs0; }
      if (op.comment && !isN1()) e.cq = op.comment;
    } else if (op.type === 'resolution') {
      e = findQr(d, op.qr); var rz = RESOL[op.kind];
      if (e && rz && e.res === rz.from) { pushHist(e, op.ts, rz.label); e.dc = iso(op.ts); e.res = OKR; if (op.comment) e.cq = op.comment; }
    } else if (op.type === 'commentaire') {
      e = findQr(d, op.qr); if (e) e.cq = op.comment;
    } else if (op.type === 'creation') {
      d.emp.push({ id: 'tmp-' + op.id, site: op.site, bat: op.bat, etage: op.etage, lieu: op.lieu, lc: op.lc || '', type: op.mat, qr: op.qr, dc: '', res: '', dr: '', cq: '', zone: op.zone || '', h: [] });
      d.qr[op.qr] = ['tmp-' + op.id, 'en service', ''];
    } else if (op.type === 'remplacement') {
      e = findQr(d, op.oldQr); if (!e) return;
      if (d.qr[op.oldQr]) { d.qr[op.oldQr][1] = 'remplacé'; d.qr[op.oldQr][2] = op.newQr; }
      d.qr[op.newQr] = [e.id, 'en service', ''];
      e.qr = op.newQr; if (op.mat) e.type = op.mat; e.dr = e.dc = iso(op.ts); e.res = OKR; e.cq = ''; e.h = [];
    } else if (op.type === 'modifier') {
      e = findQr(d, op.qr); if (!e) return;
      e.site = op.site || e.site; e.bat = op.bat; e.etage = op.etage; e.lieu = op.lieu; e.lc = op.lc || ''; e.type = op.mat; e.zone = op.zone || '';
      if (op.reset) { e.dc = ''; e.res = ''; e.dr = ''; e.cq = ''; e.h = []; }
    } else if (op.type === 'zone') {
      e = findQr(d, op.qr); if (e) e.zone = op.zone;
    } else if (op.type === 'zoneok') {
      d.emp.forEach(function (x) { if (x.site === op.site && x.zone === op.zone && !isDef(x)) { x.dc = iso(op.ts); x.res = OKR; } });
    } else if (op.type === 'mensuel' || op.type === 'annuel') {
      for (i = 0; i < d.sites.length; i++) if (d.sites[i].site === op.site) {
        var s = d.sites[i], k = op.type === 'mensuel' ? ['dm', 'mpar', 'mcom'] : ['da', 'apar', 'acom'];
        if (!s[k[0]] || op.ts >= Date.parse(s[k[0]])) { s[k[0]] = iso(op.ts); s[k[1]] = op.nom; s[k[2]] = op.comment || ''; }
      }
    }
  }

  function view() {
    if (VIEW) return VIEW;
    var d = S.server ? JSON.parse(JSON.stringify(S.server)) : { sites: [], emp: [], qr: {} };
    S.outbox.forEach(function (op) { try { applyLocal(d, op); } catch (e) {} });
    d.byId = {};
    d.emp.forEach(function (e) { d.byId[e.id] = e; });
    VIEW = d;
    return d;
  }
  function sites() { return view().sites.map(function (s) { return s.site; }); }
  function curSite() { var l = sites(); return l.indexOf(S.site) !== -1 ? S.site : (l[0] || ''); }
  function siteObj(name) { return view().sites.filter(function (s) { return s.site === name; })[0] || {}; }
  function empOf(site) { return view().emp.filter(function (e) { return e.site === site; }); }
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
        else if (!x.ok) S.rejected.push({ op: op, error: x.error, at: Date.now() });
      });
      S.outbox = keep; S.server = r.data; S.me = r.me; S.last = r.now; VIEW = null; save(); render();
      if (S.outbox.length) scheduleSync(500);
      else if (manual) toast('Synchronisé');
    }).catch(function () {
      syncing = false; netFail = true; renderHeader();
      if (manual) toast('Pas de réseau : les fiches restent sur ce téléphone');
    });
  }

  function forget() { S.code = ''; S.me = null; S.server = null; VIEW = null; M = null; R = null; camStop(); save(); }

  /* ---------- Connexion ---------- */
  function login(code) {
    if (!API || /COLLEZ/.test(API)) { authMsg = 'Adresse du serveur non renseignée (fichier config.js).'; return render(); }
    authMsg = ''; syncing = true; render();
    api({ code: code }).then(function (r) {
      syncing = false;
      if (!r.ok) { authMsg = r.error; return render(); }
      S.code = code; S.me = r.me; S.server = r.data; S.last = r.now; VIEW = null;
      tab = ''; save(); render(); sync();
      if (urlQr) { var q = urlQr; urlQr = ''; setTimeout(function () { openQr(q); }, 200); }
    }).catch(function () { syncing = false; authMsg = 'Connexion impossible : première connexion, il faut du réseau.'; render(); });
  }

  /* ---------- Rendu général ---------- */
  function tabsFor() {
    if (isN1()) return [['home', 'Accueil'], ['scan', 'Signaler un défaut']];
    var t = [['scan', 'Scanner'], ['zones', 'Zones'], ['list', 'Liste'], ['home', 'Site'], ['dash', 'Tous les sites'], ['report', 'Rapport']];
    if (niv() === 'admin') t.push(['labels', 'Étiquettes']);
    return t;
  }

  function render() {
    VIEW = VIEW || null;
    if (!S.code || !S.me) { camStop(); $('#tabs').innerHTML = ''; $('#camwrap').hidden = true; renderHeader(); renderLogin(); return; }
    if (!tab || !tabsFor().some(function (t) { return t[0] === tab; })) tab = isN1() ? 'home' : 'scan';
    renderHeader(); renderTabs();
    var scanning = tab === 'scan';
    $('#camwrap').hidden = !scanning;
    if (scanning) camStart(); else camStop();
    var v = $('#view'), h = '';
    h += banners();
    if (tab === 'scan') h += scanView();
    else if (tab === 'home') h += homeView();
    else if (tab === 'dash') h += dashView();
    else if (tab === 'zones') h += zonesView();
    else if (tab === 'list') h += listView();
    else if (tab === 'report') h += reportView();
    else if (tab === 'labels') h += labelsView();
    var keepFocus = document.activeElement && document.activeElement.id;
    var keepVal = keepFocus ? document.activeElement.value : null;
    v.innerHTML = h;
    if (tab === 'labels') drawLabels();
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
      (S.outbox.length ? '<p class="muted" style="margin-top:12px">' + plural(S.outbox.length, 'fiche en attente', 'fiches en attente') + ' sur ce téléphone : elles seront envoyées après connexion.</p>' : '');
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
    h += '<div class="stats"><div class="stat"><b>' + list.length + '</b><span>QR</span></div><div class="stat"><b style="color:var(--ok)">' + nOk + '</b><span>OK</span></div>' +
      '<div class="stat"><b style="color:var(--bad)">' + nBad + '</b><span>En défaut</span></div><div class="stat"><b>' + nNone + '</b><span>Jamais contrôlés</span></div></div>';
    if (isN1()) h += '<button class="btn" data-act="monthly" ' + (site ? '' : 'disabled') + '>Contrôle mensuel fait</button>';
    else h += '<button class="btn" data-act="annual" ' + (site ? '' : 'disabled') + '>Contrôle annuel terminé</button>';
    var bad = list.filter(function (e) { return isDef(e); });
    h += '<div class="group">En défaut (' + bad.length + ')</div>';
    h += bad.length ? '<div class="list">' + bad.map(rowHtml).join('') + '</div>' : '<div class="card muted">Aucun matériel en défaut.</div>';
    return h;
  }

  function rowHtml(e) {
    return '<button class="item' + (isDef(e) ? ' def' : '') + '" data-act="emp" data-v="' + esc(e.id) + '"><span class="l"><span class="n">' + esc(nom(e)) + '</span><br><span class="s">' +
      esc(e.bat) + ' · étage ' + esc(e.etage) + (e.zone ? ' · zone ' + esc(e.zone) : '') + ' · ' + esc(e.type) + ' · <span class="mono">' + esc(e.qr) + '</span>' +
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
      return '<button class="item" data-act="gosite" data-v="' + esc(r.so.site) + '" style="align-items:flex-start"><span class="l"><span class="n">' + esc(r.so.site) + '</span><br>' +
        '<span class="s">Mensuel : </span>' + ind(r.so.dm, MONTH) + (r.so.mpar ? ' <span class="s">' + esc(r.so.mpar) + '</span>' : '') + '<br>' +
        '<span class="s">Annuel : </span>' + ind(r.so.da, YEAR) + (r.so.apar ? ' <span class="s">' + esc(r.so.apar) + '</span>' : '') + '</span>' +
        '<span style="text-align:right"><span class="pill ' + (r.bad ? 'bad' : 'ok') + '">' + r.bad + ' en défaut</span><br><span class="s">' + r.n + ' QR · ' + r.none + ' non contrôlés</span></span></button>';
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
    h += '<p class="muted" style="margin:2px 2px 10px">Touchez une zone pour voir tous ses appareils (vert = OK, rouge = non conforme) et la valider d’un coup.</p>';
    if (!names.length) h += '<div class="card muted">Aucune zone définie pour ce site. Indiquez une zone en créant un matériel, ou depuis sa fiche (« Changer la zone »).</div>';
    h += '<div class="list">' + names.map(function (n) {
      var o = z[n];
      return '<button class="item' + (o.bad ? ' def' : '') + '" data-act="zopen" data-v="' + esc(n) + '"><span class="l"><span class="n">' + esc(n) + '</span><br><span class="s">' + plural(o.n, 'appareil', 'appareils') + '</span></span>' +
        '<span style="text-align:right"><span class="pill ok">' + o.ok + ' OK</span> <span class="pill bad">' + o.bad + ' en défaut</span> <span class="pill none">' + o.none + ' à contrôler</span></span></button>';
    }).join('') + '</div>';
    if (z['']) h += '<p class="muted" style="margin:12px 2px">' + plural(z[''].n, 'matériel sans zone', 'matériels sans zone') + ' (voir l’onglet Liste).</p>';
    return h;
  }
  function zoneDetail() {
    var l = empOf(ZN.site).filter(function (e) { return e.zone === ZN.zone; }).sort(cmpEmp);
    var bad = l.filter(isDef).length, ok = l.filter(function (e) { return !isDef(e) && e.dc; }).length, none = l.length - bad - ok, todo = l.length - bad;
    var h = '<button class="ghost" data-act="zback">‹ Toutes les zones</button><h2 style="margin:0 2px 4px">Zone « ' + esc(ZN.zone) + ' »</h2>' +
      '<p class="muted" style="margin:0 2px 10px">' + esc(ZN.site) + ' · ' + plural(l.length, 'appareil', 'appareils') + '</p>' +
      '<div class="stats"><div class="stat"><b>' + l.length + '</b><span>Appareils</span></div><div class="stat"><b style="color:var(--ok)">' + ok + '</b><span>OK</span></div>' +
      '<div class="stat"><b style="color:var(--bad)">' + bad + '</b><span>Non conformes</span></div><div class="stat"><b>' + none + '</b><span>À contrôler</span></div></div>' +
      '<button class="btn ok" data-act="zoneok" data-v="' + esc(ZN.zone) + '"' + (todo ? '' : ' disabled') + '>OK pour toute la zone' + (bad ? ' (sauf ' + bad + ' non conforme' + (bad > 1 ? 's' : '') + ')' : '') + '</button>' +
      '<div class="tiles">' + l.map(function (e) {
        var c = isDef(e) ? 'bad' : (e.dc ? 'ok' : 'none');
        return '<button class="tile ' + c + '" data-act="emp" data-v="' + esc(e.id) + '"><b>' + esc(nom(e)) + '</b><span>' + esc(e.bat) + ' · ét. ' + esc(e.etage) + '</span><span class="mono">' + esc(e.qr) + '</span><span class="t">' + (isDef(e) ? esc(e.res) : (e.dc ? 'OK · ' + fmtDate(e.dc) : 'À contrôler')) + '</span></button>';
      }).join('') + '</div>';
    return h;
  }

  /* ---------- Liste ---------- */
  function listView() {
    var site = curSite(), list = empOf(site), zs = zonesOf(site);
    var q = F.q.trim().toLowerCase();
    var items = list.filter(function (e) {
      if (F.zone === '__none' ? e.zone : (F.zone && e.zone !== F.zone)) return false;
      if (F.etat === 'bad' && !isDef(e)) return false;
      if (F.etat === 'none' && (e.dc || isDef(e))) return false;
      if (F.etat === 'ok' && (isDef(e) || !e.dc)) return false;
      return !q || (e.lieu + ' ' + e.lc + ' ' + e.bat + ' ' + e.etage + ' ' + e.type + ' ' + e.qr + ' ' + e.zone + ' ' + e.cq).toLowerCase().indexOf(q) !== -1;
    }).sort(cmpEmp);
    var h = siteSelect() + '<div class="bar"><input class="in" id="fq" type="search" placeholder="Rechercher…" value="' + esc(F.q) + '">' +
      '<select class="in" data-act="fzone" aria-label="Zone"><option value="">Toutes les zones</option><option value="__none"' + (F.zone === '__none' ? ' selected' : '') + '>Sans zone</option>' +
      zs.map(function (z) { return '<option' + (F.zone === z ? ' selected' : '') + '>' + esc(z) + '</option>'; }).join('') + '</select>' +
      '<select class="in" data-act="fetat" aria-label="État"><option value="">Tous les états</option>' +
      [['ok', 'OK'], ['bad', 'En défaut'], ['none', 'Jamais contrôlés']].map(function (o) { return '<option value="' + o[0] + '"' + (F.etat === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    h += '<p class="muted" style="margin:0 2px 6px">' + plural(items.length, 'matériel', 'matériels') + '</p>';
    var cur = '';
    items.forEach(function (e) {
      var g = e.bat + ' · étage ' + e.etage;
      if (g !== cur) { if (cur) h += '</div>'; cur = g; h += '<div class="group">' + esc(g) + '</div><div class="list">'; }
      h += rowHtml(e);
    });
    if (cur) h += '</div>'; else h += '<div class="card muted">Aucun matériel.</div>';
    return h;
  }
  function nom(e) { return e.lieu || e.lc || e.type || e.qr; }
  function cmpEmp(a, b) {
    return (a.bat + '|' + a.etage + '|' + a.lieu).localeCompare(b.bat + '|' + b.etage + '|' + b.lieu, 'fr', { numeric: true });
  }

  /* ---------- Rapport ---------- */
  function histText(e) {
    return (e.h || []).map(function (x) { var p = x.split(' | '); return fmtDate(p[0]) + ' ' + (p[1] || '') + (p[2] ? ' (' + p[2] + ')' : ''); }).join(' ; ');
  }
  function etatText(e) { return isDef(e) ? e.res : (!e.dc ? 'Jamais contrôlé' : (daysSince(e.dc) > YEAR ? 'OK (ancien)' : 'OK')); }

  function reportView() {
    var all = S.site === '*', site = curSite(), h = siteSelect(true), now = new Date();
    var head = '<div class="bar noprint"><button class="btn sm" data-act="print">Imprimer / PDF</button><button class="btn sm sec" data-act="csv">Exporter (tableur)</button></div>';
    var meta = 'Édité le ' + fmtDate(now.toISOString()) + ' à ' + hhmm(now.toISOString()) + ' · données synchronisées le ' + (S.last ? fmtDate(S.last) + ' à ' + hhmm(S.last) : 'jamais') +
      (S.outbox.length ? ' · ' + plural(S.outbox.length, 'fiche en attente d’envoi', 'fiches en attente d’envoi') + ' (comprises)' : '');
    if (all) {
      var rows = view().sites.map(function (s) {
        var l = empOf(s.site), bad = l.filter(function (e) { return isDef(e); }).length, none = l.filter(function (e) { return !e.dc && !isDef(e); }).length;
        var lr = l.map(function (e) { return e.dr; }).filter(Boolean).sort().pop();
        return '<tr><td>' + esc(s.site) + '</td><td>' + l.length + '</td><td>' + (l.length - bad - none) + '</td><td>' + bad + '</td><td>' + none + '</td><td>' + (fmtDate(s.dm) || '—') + '</td><td>' + (fmtDate(s.da) || '—') + '</td><td>' + (fmtDate(lr) || '—') + '</td></tr>';
      }).join('');
      return h + head + '<div class="card rep"><h1>Tableau de bord : tous les sites</h1><div class="meta">' + meta + '</div><div class="tablewrap"><table><thead><tr><th>Site</th><th>QR</th><th>OK</th><th>En défaut</th><th>Jamais contrôlés</th><th>Dernier mensuel</th><th>Dernier annuel</th><th>Dernier remplacement</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }
    var so = siteObj(site), l = empOf(site).sort(cmpEmp);
    var bad = l.filter(function (e) { return isDef(e); }).length, none = l.filter(function (e) { return !e.dc && !isDef(e); }).length;
    var tr = l.map(function (e) {
      return '<tr' + (isDef(e) ? ' class="def"' : '') + '><td>' + esc(e.bat) + '</td><td>' + esc(e.etage) + '</td><td>' + esc(e.zone) + '</td><td>' + esc(e.type) + '</td><td class="mono">' + esc(e.qr) + '</td><td>' +
        (fmtDate(e.dc) || '—') + '</td><td>' + esc(etatText(e)) + '</td><td class="nc">' + (isDef(e) ? esc(e.res) : '') + '</td><td>' + (fmtDate(e.dr) || '—') + '</td><td>' + esc(e.cq) + '</td><td>' + esc(histText(e)) + '</td></tr>';
    }).join('');
    return h + head + '<div class="card rep"><h1>' + esc(site) + '</h1><div class="meta">' + meta + '</div>' +
      '<p>Contrôle mensuel : <b>' + (fmtDate(so.dm) || 'jamais') + '</b>' + (so.mpar ? ' par ' + esc(so.mpar) : '') + ' · Contrôle annuel : <b>' + (fmtDate(so.da) || 'jamais') + '</b>' + (so.apar ? ' par ' + esc(so.apar) : '') +
      '<br>' + plural(l.length, 'QR', 'QR') + ' · ' + (l.length - bad - none) + ' OK · <b>' + bad + ' en défaut</b> · ' + none + ' jamais contrôlés</p>' + defBreak(l) +
      '<div class="tablewrap"><table><thead><tr><th>Bâtiment</th><th>Étage</th><th>Zone</th><th>Type</th><th>QR</th><th>Dernier contrôle</th><th>État</th><th>Non-conformité</th><th>Dernier remplacement</th><th>Commentaire</th><th>Historique depuis le dernier remplacement</th></tr></thead><tbody>' + tr + '</tbody></table></div></div>';
  }

  function defBreak(l) {
    var c = {}; l.forEach(function (e) { if (isDef(e)) c[e.res] = (c[e.res] || 0) + 1; });
    var k = Object.keys(c); if (!k.length) return '';
    return '<p>' + k.map(function (x) { return esc(x) + ' : <b>' + c[x] + '</b>'; }).join(' · ') + '</p>';
  }
  function exportCsv() {
    var site = curSite(), all = S.site === '*';
    var cols = ['Site', 'Bâtiment', 'Étage', 'Zone', 'Type', 'QR', 'Dernier contrôle', 'État', 'Non-conformité', 'Dernier remplacement', 'Commentaire QR', 'Commentaire de lieu', 'Historique depuis le dernier remplacement'];
    var lines = [cols.join(';')];
    (all ? view().emp : empOf(site)).slice().sort(function (a, b) { return a.site.localeCompare(b.site, 'fr') || cmpEmp(a, b); }).forEach(function (e) {
      lines.push([e.site, e.bat, e.etage, e.zone, e.type, e.qr, fmtDate(e.dc), etatText(e), isDef(e) ? e.res : '', fmtDate(e.dr), e.cq, e.lc, histText(e)].map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'controle-' + (all ? 'tous-sites' : site.replace(/[^\w-]+/g, '_')) + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- Étiquettes (QR vierges à imprimer) ---------- */
  var LF = { from: 1, to: 153 };
  function labelsView() {
    var from = Math.max(1, parseInt(LF.from, 10) || 1), to = Math.min(5000, Math.max(from, parseInt(LF.to, 10) || from));
    var n = to - from + 1, pages = Math.ceil(n / 153);
    return '<div class="noprint"><div class="card"><h3>QR vierges à imprimer</h3><p class="muted" style="margin:4px 0 0;font-size:13px">Version de l’application : ' + VERSION + '</p><p class="muted" style="margin:6px 0 0">Chaque QR porte un numéro. Il sera rattaché à un matériel la première fois qu’un niveau 2 le flashe.</p>' +
      '<div class="row2"><div><label class="lab" for="lfrom">Du numéro</label><input class="in" id="lfrom" type="number" min="1" max="5000" inputmode="numeric" value="' + esc(LF.from) + '"></div>' +
      '<div><label class="lab" for="lto">Au numéro</label><input class="in" id="lto" type="number" min="1" max="5000" inputmode="numeric" value="' + esc(LF.to) + '"></div></div>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap"><button class="btn sm" data-act="print">Imprimer</button><span class="muted">' + plural(n, 'étiquette', 'étiquettes') + ' · ' + plural(pages, 'page', 'pages') + ' A4 (9 × 17)</span></div>' +
      '<p class="muted" style="font-size:14px;margin:10px 0 0">Impression : échelle 100 %, sans marges ni en-têtes, option « Graphiques d’arrière-plan » cochée.</p></div></div>' +
      '<div class="labels-wrap" style="margin-top:12px"><div class="labels" id="labels"></div></div>';
  }
  function qrSvg(text) {
    if (typeof qrcode !== 'function') return '';
    var qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    var n = qr.getModuleCount(), d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ' + (n + 2) + ' ' + (n + 2) + '" shape-rendering="crispEdges"><rect x="-1" y="-1" width="' + (n + 2) + '" height="' + (n + 2) + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function drawLabels() {
    var box = $('#labels'); if (!box) return;
    var from = Math.max(1, parseInt(LF.from, 10) || 1), to = Math.min(5000, Math.max(from, parseInt(LF.to, 10) || from)), h = '';
    for (var i = from; i <= to; i++) {
      var id = 'Q-' + ('0000' + i).slice(-4);
      h += '<div class="lbl"><div class="qr">' + qrSvg(baseUrl() + '?q=' + id) + '</div><div class="tx"><div class="id">' + id + '</div></div></div>';
    }
    box.innerHTML = h;
  }

  /* ---------- Scanner ---------- */
  var stream = null, camTimer = 0, det = null, noDet = false, cv = null, camStarting = false;
  function camMsg(t) { var e = $('#camstate'); if (e) e.textContent = t; }

  function camStart() {
    if (stream || camStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMsg('Caméra indisponible ici : saisissez le numéro du QR ci-dessous.'); return; }
    camStarting = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (s) {
      camStarting = false;
      if (tab !== 'scan' || !S.me) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      var v = $('#video'); v.srcObject = s;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      camMsg(R ? 'Remplacement : flashez le NOUVEAU QR code.' : 'Visez un QR code.');
      camLoop();
    }).catch(function () { camStarting = false; camMsg('Caméra non autorisée : autorisez-la dans le navigateur, ou saisissez le numéro du QR ci-dessous.'); });
  }
  function camStop() {
    clearTimeout(camTimer);
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    var v = $('#video'); if (v) v.srcObject = null;
  }
  function camLoop() {
    clearTimeout(camTimer);
    if (!stream) return;
    var v = $('#video');
    if (M || v.readyState < 2 || !v.videoWidth) { camTimer = setTimeout(camLoop, 200); return; }
    decode(v).then(function (t) { if (t) onQr(t); }).catch(function () {}).then(function () { camTimer = setTimeout(camLoop, 110); });
  }
  function decode(v) {
    var p = Promise.resolve(null);
    if (!noDet && 'BarcodeDetector' in window) {
      try {
        det = det || new BarcodeDetector({ formats: ['qr_code'] });
        p = det.detect(v).then(function (r) { return r.length ? r[0].rawValue : null; }, function () { noDet = true; return null; });
      } catch (e) { noDet = true; }
    }
    return p.then(function (t) {
      if (t || (!noDet && 'BarcodeDetector' in window)) return t;
      if (typeof jsQR !== 'function') return null;
      var w = v.videoWidth, h = v.videoHeight, k = Math.min(1, 640 / Math.max(w, h));
      cv = cv || document.createElement('canvas');
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      var x = cv.getContext('2d', { willReadFrequently: true });
      x.drawImage(v, 0, 0, cv.width, cv.height);
      var r = jsQR(x.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
      return r ? r.data : null;
    });
  }
  function qrId(text) { var m = /(?:[?&]q=|^|\/)(Q-\d{4,5})\b/i.exec(String(text).trim()); return m ? m[1].toUpperCase() : null; }
  function onQr(text) {
    var id = qrId(text), now = Date.now();
    if (!id) { if (now - lastAt > 2500) { lastAt = now; toast('QR code non reconnu'); } return; }
    if (id === lastQr && now - lastAt < 2500) return;
    lastQr = id; lastAt = now;
    if (navigator.vibrate) navigator.vibrate(40);
    openQr(id);
  }

  function scanView() {
    var h = '';
    if (R) h += '<div class="banner">Remplacement de « ' + esc(R.label) + ' » : flashez le nouveau QR vierge. <button class="ghost" data-act="rcancel">Annuler</button></div>';
    h += '<div class="card"><label class="lab" style="margin-top:0" for="manual">Numéro du QR (si la caméra ne lit pas)</label>' +
      '<div style="display:flex;gap:8px"><input class="in" id="manual" placeholder="Q-0123" autocapitalize="characters" autocomplete="off" style="flex:1"><button class="btn sm" data-act="manual">Ouvrir</button></div></div>';
    if (isN1()) h += '<p class="muted" style="margin:10px 2px">Flashez seulement les matériels en défaut : ils seront signalés en défaut sur le tableau de bord du site.</p>';
    return h;
  }

  function openQr(id) {
    var d = view(), q = d.qr[id];
    if (R) {
      if (q) return openModal({ k: 'msg', t: id + ' est déjà attribué', m: 'Pour remplacer le matériel, flashez un QR vierge (jamais utilisé).' });
      return openModal({ k: 'replc', qr: id });
    }
    if (q) {
      if (q[1] === 'remplacé') return openModal({ k: 'msg', t: id + ' a été remplacé', m: 'Ce QR code a été remplacé par ' + q[2] + '. Il ne doit plus être utilisé : à déposer avec l’ancien matériel.' });
      var e = d.byId[q[0]];
      if (!e) return openModal({ k: 'msg', t: 'Matériel introuvable', m: 'Synchronisez puis réessayez.' });
      return openModal({ k: isN1() ? 'defect' : 'ctl', id: e.id });
    }
    if (isN1()) return openModal({ k: 'msg', t: 'QR non attribué', m: id + ' n’est rattaché à aucun matériel. Seul un niveau 2 peut le créer.' });
    openModal({ k: 'new', qr: id });
  }

  /* ---------- Fenêtres du bas ---------- */
  function openModal(m) { M = m; renderModal(); }
  function closeModal() { M = null; lastAt = Date.now(); renderModal(); }

  function empInfo(e) {
    var st = stateOf(e);
    return '<div class="muted mono" style="font-size:13px">' + esc(e.qr) + '</div><h2 style="margin:2px 0 4px">' + esc(nom(e)) + '</h2>' +
      '<div class="muted">' + esc(e.site) + ' · ' + esc(e.bat) + ' · étage ' + esc(e.etage) + (e.zone ? ' · zone ' + esc(e.zone) + ' (' + plural(zoneCount(e.site, e.zone), 'appareil', 'appareils') + ')' : '') + '</div>' +
      '<div style="margin-top:6px">' + esc(e.type) + (e.lc ? ' · <span class="muted">' + esc(e.lc) + '</span>' : '') + '</div>' +
      '<div style="margin-top:8px"><span class="pill ' + st.c + '">' + st.t + '</span> <span class="muted" style="font-size:14px">' + (e.dc ? 'contrôlé le ' + fmtDate(e.dc) : '') + (e.dr ? ' · remplacé le ' + fmtDate(e.dr) : '') + '</span></div>' + histHtml(e);
  }
  function resolBtns(e) {
    var k = Object.keys(RESOL).filter(function (k) { return RESOL[k].from === e.res; })[0];
    return k ? '<button class="btn ok" data-act="resol" data-v="' + k + '">✔ ' + RESOL[k].btn + '</button>' : '<p class="muted" style="margin:10px 0 0">Ce matériel est à remplacer : le statut reste jusqu’au remplacement (bouton ci-dessous).</p>';
  }
  function histHtml(e) {
    if (!e.h || !e.h.length) return '';
    return '<div class="group" style="padding:12px 0 4px">Historique depuis le dernier remplacement</div><ul style="margin:0;padding-left:18px;font-size:14px">' + e.h.map(function (x) {
      var p = x.split(' | '); return '<li>' + esc(fmtDate(p[0])) + ' : ' + esc(p[1] || '') + (p[2] ? ' <span class="muted">(' + esc(p[2]) + ')</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function defBtns(e) {
    return Object.keys(DEFKEY).filter(function (k) { return DEFKEY[k] !== e.res; }).map(function (k) {
      return '<button class="btn bad" data-act="ctl" data-v="' + k + '" style="font-size:16px">' + DEFKEY[k] + '</button>';
    }).join('');
  }
  function zoneField(site, cur) {
    var zs = zonesOf(site);
    return '<label class="lab" for="m-zone">Zone</label><select class="in" id="m-zone" data-act="zonesel"><option value="">— aucune —</option>' +
      zs.map(function (z) { return '<option value="' + esc(z) + '"' + (z === cur ? ' selected' : '') + '>' + esc(z) + ' (' + zoneCount(site, z) + ')</option>'; }).join('') + '<option value="__new">+ Nouvelle zone…</option></select>' +
      '<input class="in" id="m-zone-new" placeholder="Nom de la nouvelle zone" maxlength="60" style="margin-top:8px" hidden>';
  }
  function readZone() {
    var s = $('#m-zone'); if (!s) return '';
    return s.value === '__new' ? ($('#m-zone-new').value || '').trim() : s.value;
  }

  function renderModal() {
    var el = $('#modal');
    if (!M || !S.me) { el.hidden = true; el.innerHTML = ''; return; }
    var d = view(), h = '', e = M.id ? d.byId[M.id] : null;
    if (M.k === 'ctl' && e) {
      h = empInfo(e) + '<label class="lab" for="m-com">Commentaire sur ce QR</label><textarea class="in" id="m-com" rows="2" maxlength="300" placeholder="Facultatif">' + esc(e.cq) + '</textarea>' +
        (isDef(e) ? resolBtns(e) : '<button class="btn ok" data-act="ctl" data-v="OK">OK</button>') +
        '<div class="group" style="padding:12px 0 0">Signaler un défaut</div><div class="defs">' + defBtns(e) + '</div>' +
        '<div class="row2"><button class="btn sec" data-act="repl">Remplacer le matériel</button><button class="btn sec" data-act="zonechg">Changer la zone</button></div>' +
        '<button class="btn sec" data-act="edit">Modifier la fiche / réemployer ce QR</button>' +
        '<button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'defect' && e) {
      h = empInfo(e) + (isDef(e) ? '<p class="muted" style="margin:10px 0 0">Déjà signalé : ' + esc(e.res) + '.</p>' : '') +
        '<div class="group" style="padding:12px 0 0">Signaler un défaut</div><div class="defs">' + defBtns(e) + '</div><button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'new') {
      var st = S.sticky, sl = sites(), site = sl.indexOf(st.site) !== -1 ? st.site : curSite();
      h = '<div class="muted mono" style="font-size:13px">' + esc(M.qr) + '</div><h2>QR non attribué : créer le matériel</h2>' +
        '<label class="lab" for="m-site">Site</label><select class="in" id="m-site">' + sl.map(function (s) { return '<option' + (s === site ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<div class="row2"><div><label class="lab" for="m-bat">Bâtiment</label><input class="in" id="m-bat" maxlength="60" value="' + esc(st.bat || '') + '"></div>' +
        '<div><label class="lab" for="m-etage">Étage</label><input class="in" id="m-etage" maxlength="20" value="' + esc(st.etage || '') + '"></div></div>' +
        '<label class="lab" for="m-lc">Commentaire de lieu</label><input class="in" id="m-lc" maxlength="300" placeholder="Ex. hall, couloir nord…">' +
        '<label class="lab" for="m-mat">Type de matériel</label><input class="in" id="m-mat" list="types" maxlength="60" value="' + esc(st.mat || '') + '"><datalist id="types">' + typesAll().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
        zoneField(site, st.zone || '') + '<div class="err" id="m-err" role="alert"></div>' +
        '<button class="btn" data-act="newgo">Créer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'replc') {
      var oe = d.emp.filter(function (x) { return x.qr === R.oldQr; })[0] || {};
      h = '<div class="muted mono" style="font-size:13px">Nouveau QR : ' + esc(M.qr) + '</div><h2>Remplacer le matériel</h2><div class="muted">' + esc(R.label) + ' · ancien QR ' + esc(R.oldQr) + '</div>' +
        '<label class="lab" for="m-mat">Type du nouveau matériel</label><input class="in" id="m-mat" list="types" maxlength="60" value="' + esc(oe.type || '') + '"><datalist id="types">' + typesAll().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
        '<p class="muted" style="margin:10px 0 0">Le bâtiment, l’étage, le commentaire de lieu et la zone sont conservés. L’état passe à « OK » à la date du jour.</p>' +
        '<button class="btn" data-act="replgo">Confirmer le remplacement</button><button class="btn sec" data-act="rcancel">Annuler</button>';
    } else if (M.k === 'edit' && e) {
      var sl2 = sites();
      h = '<div class="muted mono" style="font-size:13px">' + esc(e.qr) + '</div><h2>Modifier la fiche</h2>' +
        '<label class="lab" for="m-site">Site</label><select class="in" id="m-site">' + sl2.map(function (x) { return '<option' + (x === e.site ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>' +
        '<div class="row2"><div><label class="lab" for="m-bat">Bâtiment</label><input class="in" id="m-bat" maxlength="60" value="' + esc(e.bat) + '"></div>' +
        '<div><label class="lab" for="m-etage">Étage</label><input class="in" id="m-etage" maxlength="20" value="' + esc(e.etage) + '"></div></div>' +
        '<label class="lab" for="m-lc">Commentaire de lieu</label><input class="in" id="m-lc" maxlength="300" value="' + esc(e.lc) + '">' +
        '<label class="lab" for="m-mat">Type de matériel</label><input class="in" id="m-mat" list="types" maxlength="60" value="' + esc(e.type) + '"><datalist id="types">' + typesAll().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
        zoneField(e.site, e.zone) +
        '<label style="display:flex;gap:10px;align-items:center;margin-top:14px"><input type="checkbox" id="m-reset" style="width:22px;height:22px"> Réemploi : autre matériel ou autre endroit, remettre le contrôle à zéro</label>' +
        '<div class="err" id="m-err" role="alert"></div><button class="btn" data-act="editgo">Enregistrer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'zonechg' && e) {
      h = '<h2>Zone de « ' + esc(nom(e)) + ' »</h2>' + zoneField(e.site, e.zone) + '<button class="btn" data-act="zonego">Enregistrer</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'monthly' || M.k === 'annual') {
      var mo = M.k === 'monthly';
      h = '<h2>' + (mo ? 'Contrôle mensuel fait' : 'Contrôle annuel terminé') + '</h2><div class="muted">' + esc(M.site) + '</div>' +
        '<label class="lab" for="m-nom">Votre nom</label><input class="in" id="m-nom" maxlength="60" autocomplete="name" value="' + esc(mo ? (S.nom || '') : (S.nom || S.me.nom)) + '">' +
        '<label class="lab" for="m-com">Commentaire</label><textarea class="in" id="m-com" rows="3" maxlength="300" placeholder="Facultatif"></textarea><div class="err" id="m-err" role="alert"></div>' +
        '<button class="btn" data-act="mago">Valider</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'zoneok') {
      var l = empOf(M.site).filter(function (x) { return x.zone === M.zone; }), bad = l.filter(function (x) { return isDef(x); }).length, okn = l.length - bad;
      h = '<h2>Valider la zone « ' + esc(M.zone) + ' »</h2><p style="font-size:18px">Voulez-vous valider les <b>' + plural(okn, 'appareil', 'appareils') + '</b> de la zone « OK » à la date d’aujourd’hui' +
        (bad ? ', <b>sauf ' + plural(bad, 'appareil', 'appareils') + '</b> en défaut (' + plural(bad, 'garde', 'gardent') + ' leur statut : à remplacer, batterie, alimentation ou télécommande)' : '') + ' ?</p>' +
        '<p class="muted" style="margin:0">La zone compte ' + plural(l.length, 'appareil', 'appareils') + ' au total.</p>' +
        '<label class="lab" for="m-com">Commentaire</label><input class="in" id="m-com" maxlength="200" placeholder="Facultatif">' +
        '<button class="btn ok" data-act="zogo"' + (okn ? '' : ' disabled') + '>Oui, valider ' + plural(okn, 'appareil', 'appareils') + '</button><button class="btn sec" data-act="close">Annuler</button>';
    } else if (M.k === 'rej') {
      h = '<h2>Opérations refusées</h2><p class="muted">Le serveur a refusé ces opérations. Elles ne seront pas renvoyées.</p><div class="list">' + S.rejected.map(function (r) {
        return '<div class="item"><span class="l"><span class="n">' + esc(opName(r.op)) + '</span><br><span class="s">' + esc(r.error) + '</span></span></div>';
      }).join('') + '</div><button class="btn" data-act="rejclear">Effacer la liste</button><button class="btn sec" data-act="close">Fermer</button>';
    } else if (M.k === 'quit') {
      h = '<h2>Quitter ?</h2><p>' + plural(S.outbox.length, 'fiche n’est pas encore envoyée', 'fiches ne sont pas encore envoyées') + '. Elles restent sur ce téléphone et partiront à la prochaine connexion, mais seront enregistrées sous le nom du prochain utilisateur.</p>' +
        '<button class="btn sec" data-act="sync">Envoyer maintenant</button><button class="btn bad" data-act="quitgo">Quitter quand même</button><button class="btn sec" data-act="close">Rester</button>';
    } else if (M.k === 'msg') {
      h = '<h2>' + esc(M.t) + '</h2><p>' + esc(M.m) + '</p><button class="btn" data-act="close">Fermer</button>';
    } else { M = null; el.hidden = true; return; }
    el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + h + '</div>';
    el.hidden = false;
  }
  function opName(op) {
    var n = { controle: 'Contrôle', commentaire: 'Commentaire', creation: 'Création', remplacement: 'Remplacement', zone: 'Changement de zone', resolution: 'Acquittement', modifier: 'Modification de fiche', zoneok: 'OK de zone', mensuel: 'Contrôle mensuel', annuel: 'Contrôle annuel' }[op.type] || op.type;
    return n + ' ' + (op.qr || op.oldQr || op.site || '') + ' (' + fmtDate(iso(op.ts)) + ')';
  }

  /* ---------- Actions ---------- */
  function val(id) { var e = $('#' + id); return e ? e.value.trim() : ''; }
  function setErr(t) { var e = $('#m-err'); if (e) e.textContent = t; }

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
    manual: function () {
      var id = qrId(val('manual')); if (!id) { toast('Numéro invalide (ex. Q-0123)'); return; }
      $('#manual').value = ''; lastQr = id; lastAt = Date.now(); openQr(id);
    },
    close: function () { closeModal(); },
    ctl: function (el) {
      var e = view().byId[M.id], k = el.getAttribute('data-v'), res = k === 'OK' ? OKR : DEFKEY[k];
      var op = { type: 'controle', qr: e.qr, result: res };
      if (!isN1()) op.comment = val('m-com');
      var label = nom(e); closeModal(); enqueue(op); toast(res + ' : ' + label);
    },
    resol: function (el) {
      var e = view().byId[M.id], k = el.getAttribute('data-v'), op = { type: 'resolution', qr: e.qr, kind: k, comment: val('m-com') };
      var label = nom(e); closeModal(); enqueue(op); toast(RESOL[k].label + ' : ' + label);
    },
    zonesel: function (el) { var n = $('#m-zone-new'); if (n) { n.hidden = el.value !== '__new'; if (!n.hidden) n.focus(); } },
    newgo: function () {
      var site = val('m-site'), f = { bat: val('m-bat'), etage: val('m-etage'), lc: val('m-lc'), mat: val('m-mat') }, zone = readZone();
      if (!site || !f.bat || !f.etage || !f.mat) return setErr('Site, bâtiment, étage et type sont obligatoires.');
      if ($('#m-zone') && $('#m-zone').value === '__new' && !zone) return setErr('Saisissez le nom de la nouvelle zone.');
      S.sticky = { site: site, bat: f.bat, etage: f.etage, mat: f.mat, zone: zone }; S.site = site;
      var q = M.qr; closeModal();
      enqueue({ type: 'creation', qr: q, site: site, bat: f.bat, etage: f.etage, lieu: '', lc: f.lc, mat: f.mat, zone: zone });
      toast('Créé : ' + q);
    },
    repl: function () {
      var e = view().byId[M.id]; R = { oldQr: e.qr, label: nom(e) }; M = null; lastAt = Date.now();
      tab = 'scan'; render(); camMsg('Remplacement : flashez le NOUVEAU QR code.');
    },
    rcancel: function () { R = null; M = null; lastAt = Date.now(); render(); },
    replgo: function () {
      var mat = val('m-mat'), nq = M.qr, old = R.oldQr; R = null; M = null; lastAt = Date.now();
      enqueue({ type: 'remplacement', oldQr: old, newQr: nq, mat: mat }); toast('Remplacé : ' + nq);
    },
    edit: function () { openModal({ k: 'edit', id: M.id }); },
    editgo: function () {
      var e = view().byId[M.id], f = { bat: val('m-bat'), etage: val('m-etage'), lc: val('m-lc'), mat: val('m-mat') }, zone = readZone();
      if (!f.bat || !f.etage || !f.mat) return setErr('Bâtiment, étage et type sont obligatoires.');
      var rs = $('#m-reset') && $('#m-reset').checked, qr = e.qr, st2 = val('m-site') || e.site;
      closeModal();
      enqueue({ type: 'modifier', qr: qr, site: st2, bat: f.bat, etage: f.etage, lieu: '', lc: f.lc, mat: f.mat, zone: zone, reset: !!rs });
      toast('Fiche modifiée : ' + qr);
    },
    zonechg: function () { openModal({ k: 'zonechg', id: M.id }); },
    zonego: function () {
      var e = view().byId[M.id], z = readZone(); closeModal();
      enqueue({ type: 'zone', qr: e.qr, zone: z }); toast('Zone enregistrée');
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
    if (a && (el.tagName === 'SELECT') && ACT[a]) { ACT[a](el); return; }
    if (el.id === 'lfrom' || el.id === 'lto') { LF[el.id === 'lfrom' ? 'from' : 'to'] = el.value; render(); }
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'fq') { F.q = el.value; render(); }
    else if (el.id === 'lfrom' || el.id === 'lto') { LF[el.id === 'lfrom' ? 'from' : 'to'] = el.value; clearTimeout(input.t); input.t = setTimeout(drawLabels, 400); }
  });
  function input() {}
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'code') ACT.login();
    else if (e.target.id === 'manual') ACT.manual();
  });

  window.addEventListener('online', function () { netFail = false; renderHeader(); sync(); });
  window.addEventListener('offline', function () { renderHeader(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) camStop();
    else if (S.me) { render(); sync(); }
  });
  setInterval(function () { if (S.me && navigator.onLine) { if (S.outbox.length || Date.now() - Date.parse(S.last || 0) > 600000) sync(); } }, 60000);

  /* ---------- Démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  render();
  if (S.code && S.me) {
    sync();
    if (urlQr) { var q0 = urlQr; urlQr = ''; setTimeout(function () { openQr(q0); }, 300); }
  }
  window.__cqr = { S: function () { return S; }, view: view, sync: sync };
})();
