/*
 * app.js — Warframe Build Calculator UI (v1, Warframe category).
 * Vanilla JS. Loads the trimmed site/data/*.json bundle, assembles the
 * solver data bundle exactly as tests/site_data.test.js does, and calls
 * window.Solver.solve on Calculate.
 */
(function () {
  'use strict';

  var STATS = [
    { key: 'abilityStrength', label: 'Ability Strength', pct: true },
    { key: 'abilityDuration', label: 'Ability Duration', pct: true },
    { key: 'abilityRange', label: 'Ability Range', pct: true },
    { key: 'abilityEfficiency', label: 'Ability Efficiency', pct: true },
    { key: 'health', label: 'Health', pct: false },
    { key: 'shield', label: 'Shield', pct: false },
    { key: 'armor', label: 'Armor', pct: false },
    { key: 'energyMax', label: 'Energy', pct: false }
  ];
  var STAT_LABEL = {};
  STATS.forEach(function (s) { STAT_LABEL[s.key] = s.label; });

  var ROUTES = [
    { key: 'mods', label: 'Mods', def: true },
    { key: 'arcanes', label: 'Arcanes', def: true },
    { key: 'shards', label: 'Archon Shards', def: true },
    { key: 'aura', label: 'Aura', def: true },
    { key: 'exilus', label: 'Exilus slot', def: true },
    { key: 'legacyHelmets', label: 'Legacy Arcane Helmets', def: false },
    { key: 'tome', label: 'Tome cross-gear', def: true },
    { key: 'conditional', label: 'Conditional buffs', def: true }
  ];

  var LS_KEY = 'wfcalc-state-v1';
  var SITE = null;      // raw site/data files
  var BUNDLE = null;    // solver-shaped bundle
  var lastResult = null;
  var lastPieces = [];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmt(n) {
    if (typeof n !== 'number') return String(n);
    return (Math.round(n * 100) / 100).toLocaleString('en-US');
  }

  // ---- bundle assembly (mirrors tests/site_data.test.js) -------------------
  function assembleBundle(site) {
    var warframes = {};
    Object.keys(site.frames).forEach(function (name) {
      var f = site.frames[name];
      warframes[name] = {
        Health: f.health, Shield: f.shield, Armor: f.armor, Energy: f.energy,
        Polarities: f.polarities, AuraPolarity: f.auraPolarity
      };
    });
    return {
      modsEffects: site.mods,
      arcaneEffects: site.arcanes,
      tomeEffects: site.tomes,
      auraEffects: site.auras,
      shardEffects: site.shards,
      warframes: { Warframes: warframes },
      legacyHelmets: site.helmets
    };
  }

  // ---- state -----------------------------------------------------------------
  function defaultState(colours) {
    var wallet = {};
    colours.forEach(function (c) {
      wallet[c] = { normal: 0, tauforged: 0, canFuseAscent: false };
    });
    var targets = {};
    STATS.forEach(function (s) { targets[s.key] = { mode: 'dontcare', value: '' }; });
    var routes = {};
    ROUTES.forEach(function (r) { routes[r.key] = r.def; });
    return {
      category: 'Warframe',
      frame: null,
      targets: targets,
      routes: routes,
      wallet: wallet,
      canFuseCoalescent: false,
      forma: 'any'
    };
  }

  function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function loadSaved() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function encodeHash(state) {
    var b = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeHash() {
    if (!location.hash || location.hash.length < 2) return null;
    try {
      var b = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) { return null; }
  }
  // Merge a (possibly partial / older) saved state over the defaults.
  function mergeState(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    if (typeof saved.frame === 'string') base.frame = saved.frame;
    if (saved.targets) {
      Object.keys(base.targets).forEach(function (k) {
        var t = saved.targets[k];
        if (t && typeof t === 'object') {
          if (['dontcare', 'closest', 'atleast'].indexOf(t.mode) >= 0) base.targets[k].mode = t.mode;
          if (t.value != null) base.targets[k].value = t.value;
        }
      });
    }
    if (saved.routes) {
      Object.keys(base.routes).forEach(function (k) {
        if (typeof saved.routes[k] === 'boolean') base.routes[k] = saved.routes[k];
      });
    }
    if (saved.wallet) {
      Object.keys(base.wallet).forEach(function (c) {
        var w = saved.wallet[c];
        if (w && typeof w === 'object') {
          base.wallet[c].normal = Math.max(0, parseInt(w.normal, 10) || 0);
          base.wallet[c].tauforged = Math.max(0, parseInt(w.tauforged, 10) || 0);
          base.wallet[c].canFuseAscent = !!w.canFuseAscent;
        }
      });
    }
    if (typeof saved.canFuseCoalescent === 'boolean') base.canFuseCoalescent = saved.canFuseCoalescent;
    if (saved.forma === 'any' || (Number.isInteger(saved.forma) && saved.forma >= 0 && saved.forma <= 10)) {
      base.forma = saved.forma;
    }
    return base;
  }

  var state = null;

  // ---- control construction ---------------------------------------------------
  function buildControls() {
    // Frame datalist
    var dl = $('frame-list');
    Object.keys(SITE.frames).sort().forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      dl.appendChild(o);
    });
    // Targets rows
    var tb = $('targets-table').querySelector('tbody');
    STATS.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', null, s.label + (s.pct ? ' (%)' : '')));
      var tdMode = el('td');
      var sel = document.createElement('select');
      sel.id = 'tgt-mode-' + s.key;
      [['dontcare', "Don't care"], ['closest', 'Closest'], ['atleast', 'At least']].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        sel.appendChild(o);
      });
      tdMode.appendChild(sel);
      tr.appendChild(tdMode);
      var tdVal = el('td');
      var inp = document.createElement('input');
      inp.type = 'number'; inp.id = 'tgt-val-' + s.key; inp.step = 'any';
      tdVal.appendChild(inp);
      tr.appendChild(tdVal);
      tb.appendChild(tr);
    });
    // Route checkboxes
    var rc = $('route-checks');
    ROUTES.forEach(function (r) {
      var lab = el('label', 'check');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'route-' + r.key;
      lab.appendChild(cb);
      lab.appendChild(el('span', null, r.label + (r.key === 'legacyHelmets' ? ' (default off)' : '')));
      rc.appendChild(lab);
    });
    // Wallet rows (colours come from shards.json)
    var wb = $('wallet-table').querySelector('tbody');
    Object.keys(SITE.shards.colours).forEach(function (colour) {
      var tr = el('tr');
      tr.appendChild(el('td', null, colour));
      [['normal', 'Normal'], ['tauforged', 'Tauforged']].forEach(function (pair) {
        var td = el('td');
        var inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.step = '1';
        inp.id = 'wal-' + colour + '-' + pair[0];
        td.appendChild(inp);
        tr.appendChild(td);
      });
      var tdF = el('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'wal-' + colour + '-ascent';
      tdF.appendChild(cb);
      tr.appendChild(tdF);
      wb.appendChild(tr);
    });
    // Forma select
    var fs = $('sel-forma');
    var oAny = document.createElement('option');
    oAny.value = 'any'; oAny.textContent = 'Any';
    fs.appendChild(oAny);
    for (var i = 0; i <= 10; i++) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = String(i);
      fs.appendChild(o);
    }
  }

  // ---- UI <-> state ----------------------------------------------------------
  function applyStateToUI() {
    if (state.frame && SITE.frames[state.frame]) $('inp-frame').value = state.frame;
    STATS.forEach(function (s) {
      $('tgt-mode-' + s.key).value = state.targets[s.key].mode;
      var inp = $('tgt-val-' + s.key);
      inp.value = state.targets[s.key].value;
      inp.disabled = state.targets[s.key].mode === 'dontcare';
    });
    ROUTES.forEach(function (r) { $('route-' + r.key).checked = !!state.routes[r.key]; });
    Object.keys(state.wallet).forEach(function (c) {
      var n = $('wal-' + c + '-normal'), t = $('wal-' + c + '-tauforged'), a = $('wal-' + c + '-ascent');
      if (n) n.value = state.wallet[c].normal;
      if (t) t.value = state.wallet[c].tauforged;
      if (a) a.checked = !!state.wallet[c].canFuseAscent;
    });
    $('chk-coalescent').checked = !!state.canFuseCoalescent;
    $('sel-forma').value = state.forma === 'any' ? 'any' : String(state.forma);
  }

  function readUIFromControls() {
    var f = $('inp-frame').value;
    if (SITE.frames[f]) state.frame = f;
    STATS.forEach(function (s) {
      state.targets[s.key].mode = $('tgt-mode-' + s.key).value;
      state.targets[s.key].value = $('tgt-val-' + s.key).value;
      $('tgt-val-' + s.key).disabled = state.targets[s.key].mode === 'dontcare';
    });
    ROUTES.forEach(function (r) { state.routes[r.key] = $('route-' + r.key).checked; });
    Object.keys(state.wallet).forEach(function (c) {
      state.wallet[c].normal = Math.max(0, parseInt($('wal-' + c + '-normal').value, 10) || 0);
      state.wallet[c].tauforged = Math.max(0, parseInt($('wal-' + c + '-tauforged').value, 10) || 0);
      state.wallet[c].canFuseAscent = $('wal-' + c + '-ascent').checked;
    });
    state.canFuseCoalescent = $('chk-coalescent').checked;
    var fv = $('sel-forma').value;
    state.forma = fv === 'any' ? 'any' : parseInt(fv, 10);
    saveState(state);
  }

  function renderFrameCard() {
    var name = state.frame;
    var f = name && SITE.frames[name];
    $('frame-name').textContent = f ? name : 'No frame selected';
    var grid = $('frame-stats');
    grid.innerHTML = '';
    var abils = $('frame-abilities');
    abils.innerHTML = '';
    if (!f) return;
    [
      ['Health', f.health], ['Shield', f.shield], ['Armor', f.armor],
      ['Energy', f.energy], ['Sprint speed', f.sprintSpeed],
      ['Aura polarity', f.auraPolarity || 'None'],
      ['Innate polarities', (f.polarities || []).join(', ') || 'None']
    ].forEach(function (pair) {
      var cell = el('div', 'cell');
      cell.appendChild(el('b', null, pair[1] == null ? '—' : String(pair[1])));
      cell.appendChild(el('span', null, pair[0]));
      grid.appendChild(cell);
    });
    (f.abilities || []).forEach(function (a) { abils.appendChild(el('li', null, a)); });
  }

  // ---- tabs ---------------------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll('#tabbar button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('section.tab').forEach(function (s) {
      s.classList.toggle('active', s.id === 'tab-' + name);
    });
  }

  // ---- solving -------------------------------------------------------------------
  function solverInput() {
    var targets = {};
    STATS.forEach(function (s) {
      var t = state.targets[s.key];
      if (t.mode === 'dontcare') return;
      var v = parseFloat(t.value);
      if (typeof v !== 'number' || isNaN(v)) return;
      targets[s.key] = { mode: t.mode, value: v };
    });
    var wallet = {};
    Object.keys(state.wallet).forEach(function (c) {
      wallet[c] = {
        normal: state.wallet[c].normal,
        tauforged: state.wallet[c].tauforged,
        canFuseAscent: !!state.wallet[c].canFuseAscent,
        canFuseCoalescent: !!state.canFuseCoalescent
      };
    });
    var routes = {};
    ROUTES.forEach(function (r) { routes[r.key] = !!state.routes[r.key]; });
    return {
      frameName: state.frame,
      targets: targets,
      routes: routes,
      shardWallet: wallet,
      formaBudget: state.forma,
      reactor: true
    };
  }

  function modDrain(name, rank) {
    var rec = null;
    (SITE.mods.mods || []).some(function (m) { if (m.name === name) { rec = m; return true; } return false; });
    if (!rec) {
      (SITE.auras.mods || []).some(function (m) { if (m.name === name) { rec = m; return true; } return false; });
    }
    return rec ? (rec.baseDrain || 0) + rank : null;
  }

  function renderResults(res) {
    lastResult = res;
    $('results-empty').hidden = true;
    $('results-body').hidden = false;

    // Achieved vs target
    var tb = $('achieved-table').querySelector('tbody');
    tb.innerHTML = '';
    var unmetStats = {};
    (res.unmetTargets || []).forEach(function (u) { unmetStats[u.stat] = true; });
    STATS.forEach(function (s) {
      var t = state.targets[s.key];
      var tr = el('tr');
      tr.appendChild(el('td', null, s.label));
      var targetText = '—';
      if (t.mode === 'atleast') targetText = '≥ ' + t.value;
      if (t.mode === 'closest') targetText = '≈ ' + t.value;
      tr.appendChild(el('td', null, targetText));
      var ach = res.achieved[s.key];
      tr.appendChild(el('td', null, ach == null ? '—' : fmt(ach)));
      var status = '—', cls = '';
      if (t.mode === 'atleast') {
        var met = !unmetStats[s.key] && ach >= parseFloat(t.value) - 1e-9;
        status = met ? 'met' : 'unmet';
        cls = met ? 'status-met' : 'status-unmet';
      } else if (t.mode === 'closest') {
        var d = Math.abs(ach - parseFloat(t.value));
        status = d < 1e-9 ? 'met' : 'off by ' + fmt(d);
        cls = d < 1e-9 ? 'status-met' : '';
      }
      tr.appendChild(el('td', cls, status));
      tb.appendChild(tr);
    });

    // Notes (includes unmet-target unlock hints + fusion records)
    var notes = $('result-notes');
    notes.innerHTML = '';
    (res.notes || []).forEach(function (n) { notes.appendChild(el('li', null, n)); });
    if (!(res.notes || []).length) notes.appendChild(el('li', null, 'All targets met.'));

    // Arrangement
    var arr = res.arrangement;
    var box = $('arrangement');
    box.innerHTML = '';
    lastPieces = [];

    function group(title, items) {
      if (!items.length) return;
      var g = el('div', 'piece-group');
      g.appendChild(el('h3', null, title));
      var ul = el('ul', 'plain');
      items.forEach(function (txt) { ul.appendChild(el('li', null, txt)); });
      g.appendChild(ul);
      box.appendChild(g);
    }
    function modLine(m) {
      var rec = null;
      (SITE.mods.mods || []).some(function (x) { if (x.name === m.name) { rec = x; return true; } return false; });
      var maxRank = rec ? rec.maxRank : '?';
      var d = modDrain(m.name, m.rank);
      return m.name + ' r' + m.rank + '/' + maxRank + (d != null ? ' — drain ' + d : '');
    }

    var normal = arr.mods.filter(function (m) { return m.slot !== 'exilus'; });
    var exilus = arr.mods.filter(function (m) { return m.slot === 'exilus'; });
    group('Mods', normal.map(modLine));
    normal.forEach(function (m) { lastPieces.push({ name: m.name, kind: 'Mod' }); });
    group('Exilus', exilus.map(modLine));
    exilus.forEach(function (m) { lastPieces.push({ name: m.name, kind: 'Exilus mod' }); });
    if (arr.aura) {
      var aRec = null;
      (SITE.auras.mods || []).some(function (x) { if (x.name === arr.aura) { aRec = x; return true; } return false; });
      var aDrain = aRec ? modDrain(arr.aura, aRec.maxRank || 0) : null;
      group('Aura', [arr.aura + (aRec ? ' r' + (aRec.maxRank || 0) + '/' + (aRec.maxRank || 0) : '') + (aDrain != null ? ' — drain ' + aDrain : '')]);
      lastPieces.push({ name: arr.aura, kind: 'Aura' });
    }
    group('Arcanes', arr.arcanes || []);
    (arr.arcanes || []).forEach(function (n) { lastPieces.push({ name: n, kind: 'Arcane' }); });
    var shardLines = (arr.shards || []).map(function (s) {
      return s.colour + ' Archon Shard (' + s.tier + ') — ' + (STAT_LABEL[s.stat] || s.stat);
    });
    group('Archon Shards', shardLines);
    (arr.shards || []).forEach(function (s) {
      lastPieces.push({ name: s.colour + ' Archon Shard', kind: 'Archon Shard (' + s.tier + ', ' + (STAT_LABEL[s.stat] || s.stat) + ')' });
    });
    var fusionNotes = (res.notes || []).filter(function (n) { return n.indexOf('Fusion:') >= 0; });
    if (fusionNotes.length) group('Shard fusions used', fusionNotes);
    if (arr.helmet) {
      group('Legacy Arcane Helmet', [arr.helmet]);
      lastPieces.push({ name: arr.helmet, kind: 'Legacy Arcane Helmet' });
    }
    if (arr.tome) {
      group('Tome mod (cross-gear, support item treated as already built)', [arr.tome]);
      lastPieces.push({ name: arr.tome, kind: 'Tome mod (cross-gear)' });
    }
    if (!box.children.length) box.appendChild(el('p', 'muted', 'Empty build — no pieces needed for the current targets.'));

    $('capacity-line').textContent =
      'Mod capacity: ' + arr.capacityUsed + ' / ' + arr.capacityMax +
      ' · Forma used: ' + arr.formaUsed;
    var fl = $('forma-line');
    fl.innerHTML = '';
    if (arr.formaPlan && arr.formaPlan.length) {
      var p = el('p', null, 'Forma plan: ' + arr.formaPlan.map(function (f) {
        return 'slot ' + (f.slot + 1) + ' → ' + f.polarity;
      }).join('; '));
      fl.appendChild(p);
    }
    renderAcquisition();
  }

  function renderAcquisition() {
    var hint = $('acq-hint');
    var table = $('acq-table');
    if (!lastResult) {
      hint.textContent = 'Run Calculate to see acquisition for a build.';
      hint.hidden = false;
      table.hidden = true;
      return;
    }
    hint.hidden = true;
    table.hidden = false;
    var tb = table.querySelector('tbody');
    tb.innerHTML = '';
    var acq = SITE.acquisition || { sources: {}, wiki: {} };
    lastPieces.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, p.kind));
      var srcs = (acq.sources || {})[p.name] || [];
      tr.appendChild(el('td', null, srcs.length ? srcs.join('; ') : '—'));
      var tdW = el('td');
      var url = (acq.wiki || {})[p.name] ||
        'https://wiki.warframe.com/w/' + p.name.replace(/ /g, '_');
      var a = el('a', null, 'Wiki');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      tdW.appendChild(a);
      tr.appendChild(tdW);
      tb.appendChild(tr);
    });
    if (!lastPieces.length) {
      var tr = el('tr');
      var td = el('td', null, 'The calculated build uses no pieces.');
      td.colSpan = 4;
      tr.appendChild(td);
      tb.appendChild(tr);
    }
  }

  function calculate() {
    readUIFromControls();
    if (!state.frame || !SITE.frames[state.frame]) {
      $('calc-status').textContent = 'Pick a valid frame first (Item tab).';
      showTab('item');
      return;
    }
    var btn = $('btn-calc');
    btn.disabled = true;
    $('calc-status').textContent = 'Calculating…';
    setTimeout(function () {
      try {
        var res = window.Solver.solve(solverInput(), BUNDLE);
        renderResults(res);
        $('calc-status').textContent = '';
        showTab('results');
      } catch (e) {
        $('calc-status').textContent = 'Solver error: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    }, 30);
  }

  // ---- boot -----------------------------------------------------------------------
  function fetchJSON(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
      return r.json();
    });
  }

  function init() {
    Promise.all([
      fetchJSON('data/frames.json'), fetchJSON('data/mods.json'),
      fetchJSON('data/arcanes.json'), fetchJSON('data/tomes.json'),
      fetchJSON('data/auras.json'), fetchJSON('data/shards.json'),
      fetchJSON('data/helmets.json'), fetchJSON('data/acquisition.json')
    ]).then(function (parts) {
      SITE = {
        frames: parts[0], mods: parts[1], arcanes: parts[2], tomes: parts[3],
        auras: parts[4], shards: parts[5], helmets: parts[6], acquisition: parts[7]
      };
      BUNDLE = assembleBundle(SITE);
      var colours = Object.keys(SITE.shards.colours);
      state = defaultState(colours);
      // Share-link state wins over localStorage.
      state = mergeState(state, decodeHash() || loadSaved());
      if (!state.frame || !SITE.frames[state.frame]) {
        state.frame = SITE.frames.Follie ? 'Follie' : Object.keys(SITE.frames).sort()[0];
      }
      buildControls();
      applyStateToUI();
      renderFrameCard();

      document.querySelectorAll('#tabbar button').forEach(function (b) {
        b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
      });
      $('btn-calc').addEventListener('click', calculate);
      $('btn-share').addEventListener('click', function () {
        readUIFromControls();
        var url = location.href.split('#')[0] + '#' + encodeHash(state);
        try { history.replaceState(null, '', url); } catch (e) { /* file:// */ }
        function done() { $('calc-status').textContent = 'Share link copied.'; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () {
            window.prompt('Copy this share link:', url);
          });
        } else {
          window.prompt('Copy this share link:', url);
        }
      });
      // Persist + live updates on any control change.
      document.querySelector('main').addEventListener('change', function () {
        readUIFromControls();
        renderFrameCard();
      });
      $('inp-frame').addEventListener('input', function () {
        if (SITE.frames[$('inp-frame').value]) {
          readUIFromControls();
          renderFrameCard();
        }
      });
      renderAcquisition();
    }).catch(function (e) {
      $('calc-status').textContent = 'Failed to load site data: ' + e.message;
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
