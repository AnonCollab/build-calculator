/*
 * app.js — Warframe Build Calculator UI (S4: all categories).
 * Vanilla JS. Loads the trimmed site/data/*.json bundle, assembles the
 * solver data bundle exactly as tests/site_data.test.js does, and runs
 * solves in a Web Worker (site/js/solve-worker.js) with a main-thread
 * fallback when Worker construction fails.
 *
 * Categories: Warframe / Necramech / Companion (frame solver),
 * Primary / Secondary / Melee / Archgun / Archmelee / Companion Weapon /
 * Kitgun / Zaw (weapon solver; Kitguns and Zaws are assembled from
 * parts by modular.js first), Amp (modular.js arcane solve).
 */
(function () {
  'use strict';

  // ---- stat definitions -----------------------------------------------------
  var FRAME_STATS = [
    { key: 'abilityStrength', label: 'Ability Strength', pct: true },
    { key: 'abilityDuration', label: 'Ability Duration', pct: true },
    { key: 'abilityRange', label: 'Ability Range', pct: true },
    { key: 'abilityEfficiency', label: 'Ability Efficiency', pct: true },
    { key: 'health', label: 'Health', pct: false },
    { key: 'shield', label: 'Shield', pct: false },
    { key: 'armor', label: 'Armor', pct: false },
    { key: 'energyMax', label: 'Energy', pct: false }
  ];
  var COMPANION_STATS = FRAME_STATS.filter(function (s) {
    return ['health', 'shield', 'armor', 'energyMax'].indexOf(s.key) >= 0;
  });
  var WEAPON_STATS = [
    { key: 'totalDamagePerShot', label: 'Damage per shot' },
    { key: 'critChance', label: 'Crit chance (%)' },
    { key: 'critMultiplier', label: 'Crit multiplier' },
    { key: 'statusChance', label: 'Status chance (%)' },
    { key: 'fireRate', label: 'Fire rate' },
    { key: 'multishot', label: 'Multishot' },
    { key: 'magazine', label: 'Magazine' },
    { key: 'reload', label: 'Reload (s)', lowerBetter: true },
    { key: 'punchThrough', label: 'Punch through' }
  ];
  var AMP_STATS = [
    { key: 'damage', label: 'Damage' },
    { key: 'critChance', label: 'Crit chance (%)', frac: true },
    { key: 'critMultiplier', label: 'Crit multiplier' },
    { key: 'statusChance', label: 'Status chance (%)', frac: true },
    { key: 'fireRate', label: 'Fire rate' },
    { key: 'multishot', label: 'Multishot' }
  ];
  function statLabel(stats, key) {
    for (var i = 0; i < stats.length; i++) if (stats[i].key === key) return stats[i].label;
    return key;
  }
  var FRAME_LABEL = {};
  FRAME_STATS.forEach(function (s) { FRAME_LABEL[s.key] = s.label; });

  var ROUTES_FRAME = [
    { key: 'mods', label: 'Mods', def: true },
    { key: 'arcanes', label: 'Arcanes', def: true },
    { key: 'shards', label: 'Archon Shards', def: true },
    { key: 'aura', label: 'Aura', def: true },
    { key: 'exilus', label: 'Exilus slot', def: true },
    { key: 'legacyHelmets', label: 'Legacy Arcane Helmets', def: false },
    { key: 'tome', label: 'Tome cross-gear', def: true },
    { key: 'conditional', label: 'Conditional buffs', def: true },
    { key: 'helminth', label: 'Helminth subsume', def: false }
  ];
  // Routes that exist on Necramechs / Companions (the solver forces the
  // rest off for those item kinds; the UI hides them there too).
  var SUBSET_KIND_ROUTES = ['mods', 'conditional'];
  var ROUTES_WEAPON = [
    { key: 'mods', label: 'Mods', def: true },
    { key: 'arcanes', label: 'Arcanes (1 slot)', def: true },
    { key: 'exilus', label: 'Exilus slot', def: true },
    { key: 'stance', label: 'Stance / posture slot', def: true },
    { key: 'conditional', label: 'Conditional buffs', def: true }
  ];

  var CATEGORIES = [
    { id: 'Warframe', kind: 'frame' },
    { id: 'Primary', kind: 'weapon', slots: ['Primary'] },
    { id: 'Secondary', kind: 'weapon', slots: ['Secondary'] },
    { id: 'Melee', kind: 'weapon', slots: ['Melee'] },
    { id: 'Archgun', kind: 'weapon', slots: ['Archgun', 'Archgun (Atmosphere)'] },
    { id: 'Archmelee', kind: 'weapon', slots: ['Archmelee'] },
    { id: 'Companion', kind: 'companion' },
    { id: 'Companion Weapon', kind: 'weapon', slots: ['Beast', 'Robotic', 'Hound'] },
    { id: 'Necramech', kind: 'necramech' },
    { id: 'Kitgun', kind: 'kitgun' },
    { id: 'Zaw', kind: 'zaw' },
    { id: 'Amp', kind: 'amp' }
  ];
  function catOf(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return CATEGORIES[0];
  }
  function isWeaponKind(kind) { return kind === 'weapon' || kind === 'kitgun' || kind === 'zaw'; }
  function isFrameKind(kind) { return kind === 'frame' || kind === 'necramech' || kind === 'companion'; }

  var LS_KEY = 'wfcalc-state-v1';
  var SITE = null;      // raw site/data files
  var BUNDLE = null;    // solver-shaped bundle
  var lastResult = null;
  var lastKind = null;
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
  function fmtInt(n) {
    if (typeof n !== 'number') return String(n);
    return Math.round(n).toLocaleString('en-US');
  }

  // ---- bundle assembly (mirrors tests/site_data.test.js) -------------------
  function assembleBundle(site) {
    var warframes = {};
    Object.keys(site.frames.warframes).forEach(function (name) {
      var f = site.frames.warframes[name];
      warframes[name] = {
        Health: f.health, Shield: f.shield, Armor: f.armor, Energy: f.energy,
        Polarities: f.polarities, AuraPolarity: f.auraPolarity,
        Abilities: f.abilities
      };
    });
    return {
      modsEffects: site.mods,
      arcaneEffects: site.arcanes,
      tomeEffects: site.tomes,
      auraEffects: site.auras,
      shardEffects: site.shards,
      setBonuses: site.setBonuses,
      helminth: site.helminth,
      linkEffects: site.links,
      warframes: { Warframes: warframes, Necramechs: site.frames.necramechs },
      companions: { Companions: site.frames.companions },
      weapons: site.weapons,
      legacyHelmets: site.helmets
    };
  }
  function modularData() {
    return {
      modular: SITE.modular.modular,
      weapons: SITE.weapons,
      braces: SITE.modular.braces,
      arcaneEffects: SITE.arcanes
    };
  }

  // ---- state -----------------------------------------------------------------
  function emptyTargets(stats) {
    var t = {};
    stats.forEach(function (s) { t[s.key] = { mode: 'dontcare', value: '' }; });
    return t;
  }
  function defaultState() {
    var wallet = {};
    Object.keys(SITE.shards.colours).forEach(function (c) {
      wallet[c] = { normal: 0, tauforged: 0, canFuseAscent: false };
    });
    var routesFrame = {}, routesWeapon = {};
    ROUTES_FRAME.forEach(function (r) { routesFrame[r.key] = r.def; });
    ROUTES_WEAPON.forEach(function (r) { routesWeapon[r.key] = r.def; });
    return {
      version: 2,
      category: 'Warframe',
      selections: {
        Warframe: null, Necramech: null, Companion: null,
        Primary: null, Secondary: null, Melee: null, Archgun: null,
        Archmelee: null, 'Companion Weapon': null
      },
      parts: {
        kitgun: { grip: 'Haymaker', chamber: 'Catchmoon', loader: 'Splat' },
        zaw: { strike: 'Dehtat', grip: 'Shtung', link: 'Ruhang' },
        amp: { prism: 'Raplak Prism', scaffold: 'Shraksun Scaffold', brace: 'Lohrin Brace' },
        moa: { model: 'Para', core: 'Drex', gyro: 'Trux', bracket: 'Drimper' },
        hound: { model: 'Hec', core: 'Garmr', bracket: 'Zubb', stabilizer: 'Frak' }
      },
      attackByItem: {},
      frameTargets: emptyTargets(FRAME_STATS),
      weaponTargets: emptyTargets(WEAPON_STATS),
      ampTargets: emptyTargets(AMP_STATS),
      routesFrame: routesFrame,
      routesWeapon: routesWeapon,
      ampConditional: true,
      abilityLocks: {},
      wallet: wallet,
      canFuseCoalescent: false,
      forma: 'any',
      umbraForma: 0,
      supportSetPieces: {},
      ownerStats: { health: '', shield: '', armor: '' },
      progenitor: { element: 'Heat', percent: 60 }
    };
  }

  function mergeTargets(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.keys(base).forEach(function (k) {
      var t = saved[k];
      if (t && typeof t === 'object') {
        if (['dontcare', 'closest', 'atleast'].indexOf(t.mode) >= 0) base[k].mode = t.mode;
        if (t.value != null) base[k].value = t.value;
      }
    });
  }
  function mergeRoutes(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.keys(base).forEach(function (k) {
      if (typeof saved[k] === 'boolean') base[k] = saved[k];
    });
  }
  // Merge a (possibly partial / older v1) saved state over the defaults.
  // Anything unrecognised is ignored; this must never throw.
  function mergeState(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    try {
      if (saved.version === 2) {
        if (catOf(saved.category).id === saved.category) base.category = saved.category;
        if (saved.selections) {
          Object.keys(base.selections).forEach(function (k) {
            if (typeof saved.selections[k] === 'string') base.selections[k] = saved.selections[k];
          });
        }
        if (saved.parts) {
          Object.keys(base.parts).forEach(function (fam) {
            var p = saved.parts[fam];
            if (p && typeof p === 'object') {
              Object.keys(base.parts[fam]).forEach(function (k) {
                if (typeof p[k] === 'string') base.parts[fam][k] = p[k];
              });
            }
          });
        }
        if (saved.attackByItem && typeof saved.attackByItem === 'object') {
          Object.keys(saved.attackByItem).forEach(function (k) {
            var v = parseInt(saved.attackByItem[k], 10);
            if (Number.isInteger(v) && v >= 0) base.attackByItem[k] = v;
          });
        }
        mergeTargets(base.frameTargets, saved.frameTargets);
        mergeTargets(base.weaponTargets, saved.weaponTargets);
        mergeTargets(base.ampTargets, saved.ampTargets);
        mergeRoutes(base.routesFrame, saved.routesFrame);
        mergeRoutes(base.routesWeapon, saved.routesWeapon);
        if (typeof saved.ampConditional === 'boolean') base.ampConditional = saved.ampConditional;
        if (saved.abilityLocks && typeof saved.abilityLocks === 'object') {
          Object.keys(saved.abilityLocks).forEach(function (f) {
            var a = saved.abilityLocks[f];
            if (Array.isArray(a)) base.abilityLocks[f] = a.map(function (x) { return !!x; });
          });
        }
        if (saved.supportSetPieces && typeof saved.supportSetPieces === 'object') {
          Object.keys(saved.supportSetPieces).forEach(function (s) {
            var n = parseInt(saved.supportSetPieces[s], 10);
            if (Number.isInteger(n) && n > 0) base.supportSetPieces[s] = n;
          });
        }
        if (saved.ownerStats) {
          ['health', 'shield', 'armor'].forEach(function (k) {
            if (saved.ownerStats[k] != null) base.ownerStats[k] = saved.ownerStats[k];
          });
        }
        if (saved.progenitor) {
          if (typeof saved.progenitor.element === 'string') base.progenitor.element = saved.progenitor.element;
          var pp = parseFloat(saved.progenitor.percent);
          if (!isNaN(pp)) base.progenitor.percent = Math.min(60, Math.max(25, pp));
        }
        if (Number.isInteger(saved.umbraForma) && saved.umbraForma >= 0) base.umbraForma = saved.umbraForma;
      } else {
        // v1 state (no version field): frame / targets / routes / wallet.
        if (typeof saved.frame === 'string') base.selections.Warframe = saved.frame;
        mergeTargets(base.frameTargets, saved.targets);
        mergeRoutes(base.routesFrame, saved.routes);
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
    } catch (e) { /* a corrupt save falls back to defaults */ }
    return base;
  }

  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function loadSaved() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function encodeHash(s) {
    var b = btoa(unescape(encodeURIComponent(JSON.stringify(s))));
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

  var state = null;

  // ---- item resolution ---------------------------------------------------------
  function currentCat() { return catOf(state.category); }

  function itemNames(cat) {
    if (cat.kind === 'frame') return Object.keys(SITE.frames.warframes).sort();
    if (cat.kind === 'necramech') return Object.keys(SITE.frames.necramechs).sort();
    if (cat.kind === 'companion') {
      // Named companions with published stats only. The modular MOA/Hound
      // store entries are NOT listed: the companion dropdown offers the
      // "Moa"/"Hound" type options instead (see companionOptions).
      return Object.keys(SITE.frames.companions).filter(function (n) {
        return typeof SITE.frames.companions[n].Health === 'number';
      }).sort();
    }
    if (cat.kind === 'weapon') {
      return Object.keys(SITE.weapons).filter(function (n) {
        return cat.slots.indexOf(SITE.weapons[n].Slot) >= 0;
      }).sort();
    }
    return [];
  }

  function kitgunFamily() {
    var mod = SITE.modular.modular;
    var grip = state.parts.kitgun.grip;
    if (mod.KitgunPrimary && mod.KitgunPrimary.Grip && mod.KitgunPrimary.Grip[grip]) return 'KitgunPrimary';
    return 'KitgunSecondary';
  }

  // {name, entry} for weapon-kind categories (store, kitgun, zaw).
  function currentWeapon() {
    var cat = currentCat();
    if (cat.kind === 'weapon') {
      var name = state.selections[cat.id];
      return name && SITE.weapons[name] ? { name: name, entry: SITE.weapons[name], assembled: false } : null;
    }
    if (cat.kind === 'kitgun') {
      var p = state.parts.kitgun;
      var w = window.Modular.assembleKitgun(modularData(), p.chamber, p.grip, p.loader);
      return { name: w.Name, entry: w, assembled: true };
    }
    if (cat.kind === 'zaw') {
      var q = state.parts.zaw;
      var z = window.Modular.assembleZaw(modularData(), q.strike, q.grip, q.link);
      return { name: z.Name, entry: z, assembled: true };
    }
    return null;
  }

  function currentAmp() {
    var p = state.parts.amp;
    return window.Modular.assembleAmp(modularData(), p.prism, p.scaffold, p.brace);
  }

  // Modular companion types are selected via sentinels, not store names:
  // the store's individual MOA/Hound model entries are not picker options.
  var MOA_SENTINEL = '__MOA__';
  var HOUND_SENTINEL = '__HOUND__';
  function companionStoreEntry() {
    var name = state.selections.Companion;
    if (!name || name === MOA_SENTINEL || name === HOUND_SENTINEL) return null;
    return SITE.frames.companions[name] || null;
  }
  // 'MOA' | 'Hound' | null — the modular type of the current selection,
  // whether it came from a type sentinel or a legacy saved store entry.
  function companionType() {
    var sel = state.selections.Companion;
    if (sel === MOA_SENTINEL) return 'MOA';
    if (sel === HOUND_SENTINEL) return 'Hound';
    var e = sel && SITE.frames.companions[sel];
    return e && typeof e.Health !== 'number' ? e.Type : null;
  }
  // [value, label] pairs for the companion dropdown: every named companion
  // with published stats, then the two modular type options.
  function companionOptions() {
    var opts = itemNames(catOf('Companion')).map(function (n) { return [n, n]; });
    opts.push([MOA_SENTINEL, 'Moa']);
    opts.push([HOUND_SENTINEL, 'Hound']);
    return opts;
  }
  // Older saves selected a modular companion by its store name (e.g.
  // "Para Moa"); fold those into the matching type sentinel, keeping the
  // chosen model in the part picker state.
  function migrateCompanionSelection() {
    var sel = state.selections.Companion;
    var e = sel && SITE.frames.companions[sel];
    if (!e || typeof e.Health === 'number') return;
    var modelName = sel.replace(/ (Moa|MOA|Hound)$/, '');
    if (e.Type === 'MOA') {
      if (SITE.modular.modular.MOA.Model[modelName]) {
        state.parts.moa.model = modelName;
        if ($('sel-moa-model')) $('sel-moa-model').value = modelName;
      }
      state.selections.Companion = MOA_SENTINEL;
    } else if (e.Type === 'Hound') {
      if (SITE.modular.modular.Hound.Model[modelName]) {
        state.parts.hound.model = modelName;
        if ($('sel-hound-model')) $('sel-hound-model').value = modelName;
      }
      state.selections.Companion = HOUND_SENTINEL;
    }
  }
  // {frameName, companionEntry|null} for the frame solver.
  function currentCompanion() {
    var type = companionType();
    if (!type) {
      var name = state.selections.Companion;
      return name && SITE.frames.companions[name]
        ? { frameName: name, companionEntry: null } : null;
    }
    var md = modularData();
    if (type === 'MOA') {
      var m = window.Modular.assembleMOA(md, state.parts.moa.model, state.parts.moa.core,
        state.parts.moa.gyro, state.parts.moa.bracket);
      return { frameName: m.Name, companionEntry: m };
    }
    var h = window.Modular.assembleHound(md, state.parts.hound.model, state.parts.hound.core,
      state.parts.hound.bracket, state.parts.hound.stabilizer);
    return { frameName: h.Name, companionEntry: h };
  }

  function currentAttackIndex(entry) {
    var saved = state.attackByItem[currentItemKey()];
    if (Number.isInteger(saved) && entry.Attacks && entry.Attacks[saved]) return saved;
    var d = (entry._TooltipAttackDisplay || 1) - 1;
    return (entry.Attacks && entry.Attacks[d]) ? d : 0;
  }
  function currentItemKey() {
    var cat = currentCat();
    if (cat.kind === 'kitgun') { var p = state.parts.kitgun; return 'kitgun:' + p.chamber + '/' + p.grip + '/' + p.loader; }
    if (cat.kind === 'zaw') { var q = state.parts.zaw; return 'zaw:' + q.strike + '/' + q.grip + '/' + q.link; }
    if (cat.kind === 'amp') { var a = state.parts.amp; return 'amp:' + a.prism + '/' + a.scaffold + '/' + a.brace; }
    return state.selections[cat.id] || cat.id;
  }

  // ---- control construction -----------------------------------------------------
  function fillSelect(sel, names, value) {
    sel.innerHTML = '';
    names.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
    if (names.indexOf(value) >= 0) sel.value = value;
    else if (names.length) sel.value = names[0];
    return sel.value;
  }
  function buildTargetRows(tbody, stats, prefix) {
    stats.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', null, s.label + (s.pct ? ' (%)' : '')));
      var tdMode = el('td');
      var sel = document.createElement('select');
      sel.id = prefix + '-mode-' + s.key;
      [['dontcare', "Don't care"], ['closest', 'Closest'], ['atleast', 'At least']].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        sel.appendChild(o);
      });
      tdMode.appendChild(sel);
      tr.appendChild(tdMode);
      var tdVal = el('td');
      var inp = document.createElement('input');
      inp.type = 'number'; inp.id = prefix + '-val-' + s.key; inp.step = 'any';
      tdVal.appendChild(inp);
      tr.appendChild(tdVal);
      tbody.appendChild(tr);
    });
  }
  function buildRouteChecks(container, routes, prefix, subsetOnly) {
    routes.forEach(function (r) {
      if (subsetOnly && subsetOnly.indexOf(r.key) < 0) return;
      var lab = el('label', 'check');
      lab.id = prefix + '-wrap-' + r.key;
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = prefix + '-' + r.key;
      lab.appendChild(cb);
      lab.appendChild(el('span', null, r.label + (r.key === 'legacyHelmets' ? ' (default off)' : '') + (r.key === 'helminth' ? ' (default off)' : '')));
      container.appendChild(lab);
    });
  }
  function buildControls() {
    buildTargetRows($('targets-frame-table').querySelector('tbody'), FRAME_STATS, 'ftgt');
    buildTargetRows($('targets-weapon-table').querySelector('tbody'), WEAPON_STATS, 'wtgt');
    buildTargetRows($('targets-amp-table').querySelector('tbody'), AMP_STATS, 'atgt');
    buildRouteChecks($('route-checks-frame'), ROUTES_FRAME, 'route', null);
    buildRouteChecks($('route-checks-weapon'), ROUTES_WEAPON, 'wroute', null);
    // Wallet rows
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
    // Support set piece rows
    var sb = $('sets-table').querySelector('tbody');
    Object.keys(SITE.setBonuses.sets).sort().forEach(function (setName) {
      var tr = el('tr');
      tr.appendChild(el('td', null, setName));
      var td = el('td');
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.className = 'sets-count';
      inp.id = 'setcount-' + setName;
      td.appendChild(inp);
      tr.appendChild(td);
      sb.appendChild(tr);
    });
    // Part selects
    var mod = SITE.modular.modular;
    var grips = {};
    ['KitgunPrimary', 'KitgunSecondary'].forEach(function (f) {
      Object.keys(mod[f].Grip).forEach(function (g) { grips[g] = f; });
    });
    fillSelect($('sel-kg-grip'), Object.keys(grips).sort(), state.parts.kitgun.grip);
    fillSelect($('sel-zaw-strike'), Object.keys(mod.Zaw.Strike).sort(), state.parts.zaw.strike);
    fillSelect($('sel-zaw-grip'), Object.keys(mod.Zaw.Grip).sort(), state.parts.zaw.grip);
    fillSelect($('sel-zaw-link'), Object.keys(mod.Zaw.Link).sort(), state.parts.zaw.link);
    var prisms = [], scaffolds = [];
    Object.keys(SITE.weapons).forEach(function (n) {
      if (SITE.weapons[n].Slot !== 'Amp') return;
      if (/Prism/.test(n)) prisms.push(n);
      if (/Scaffold/.test(n)) scaffolds.push(n);
    });
    fillSelect($('sel-amp-prism'), prisms.sort(), state.parts.amp.prism);
    fillSelect($('sel-amp-scaffold'), scaffolds.sort(), state.parts.amp.scaffold);
    fillSelect($('sel-amp-brace'), Object.keys(SITE.modular.braces.braces).sort(), state.parts.amp.brace);
    fillSelect($('sel-moa-model'), Object.keys(mod.MOA.Model).sort(), state.parts.moa.model);
    fillSelect($('sel-moa-core'), Object.keys(mod.MOA.Core).sort(), state.parts.moa.core);
    fillSelect($('sel-moa-gyro'), Object.keys(mod.MOA.Gyro).sort(), state.parts.moa.gyro);
    fillSelect($('sel-moa-bracket'), Object.keys(mod.MOA.Bracket).sort(), state.parts.moa.bracket);
    fillSelect($('sel-hound-model'), Object.keys(mod.Hound.Model).sort(), state.parts.hound.model);
    fillSelect($('sel-hound-core'), Object.keys(mod.Hound.Core).sort(), state.parts.hound.core);
    fillSelect($('sel-hound-bracket'), Object.keys(mod.Hound.Bracket).sort(), state.parts.hound.bracket);
    fillSelect($('sel-hound-stabilizer'), Object.keys(mod.Hound.Stabilizer).sort(), state.parts.hound.stabilizer);
    syncKitgunPartSelects();
  }
  function syncKitgunPartSelects() {
    var fam = kitgunFamily();
    var mod = SITE.modular.modular[fam];
    state.parts.kitgun.chamber = fillSelect($('sel-kg-chamber'),
      Object.keys(mod.Chamber).sort(), state.parts.kitgun.chamber);
    state.parts.kitgun.loader = fillSelect($('sel-kg-loader'),
      Object.keys(mod.Loader).sort(), state.parts.kitgun.loader);
  }

  // ---- UI <-> state ---------------------------------------------------------------
  function applyTargetsToUI(store, prefix) {
    Object.keys(store).forEach(function (k) {
      var mode = $(prefix + '-mode-' + k), val = $(prefix + '-val-' + k);
      if (!mode || !val) return;
      mode.value = store[k].mode;
      val.value = store[k].value;
      val.disabled = store[k].mode === 'dontcare';
    });
  }
  function readTargetsFromUI(store, prefix) {
    Object.keys(store).forEach(function (k) {
      var mode = $(prefix + '-mode-' + k), val = $(prefix + '-val-' + k);
      if (!mode || !val) return;
      store[k].mode = mode.value;
      store[k].value = val.value;
      val.disabled = store[k].mode === 'dontcare';
    });
  }
  function applyStateToUI() {
    $('sel-category').value = state.category;
    var cat = currentCat();
    // Companions use their own dropdown; refreshPicker (run right after
    // this in init) migrates + validates that selection.
    if ((isFrameKind(cat.kind) || cat.kind === 'weapon') && cat.kind !== 'companion') {
      var names = itemNames(cat);
      var cur = state.selections[cat.id];
      if (!cur || names.indexOf(cur) < 0) {
        state.selections[cat.id] = names.indexOf(defaultPick(cat)) >= 0 ? defaultPick(cat) : names[0];
      }
      $('inp-item').value = state.selections[cat.id] || '';
    }
    applyTargetsToUI(state.frameTargets, 'ftgt');
    applyTargetsToUI(state.weaponTargets, 'wtgt');
    applyTargetsToUI(state.ampTargets, 'atgt');
    ROUTES_FRAME.forEach(function (r) {
      var cb = $('route-' + r.key);
      if (cb) cb.checked = !!state.routesFrame[r.key];
    });
    ROUTES_WEAPON.forEach(function (r) {
      var cb = $('wroute-' + r.key);
      if (cb) cb.checked = !!state.routesWeapon[r.key];
    });
    $('chk-amp-conditional').checked = !!state.ampConditional;
    Object.keys(state.wallet).forEach(function (c) {
      var n = $('wal-' + c + '-normal'), t = $('wal-' + c + '-tauforged'), a = $('wal-' + c + '-ascent');
      if (n) n.value = state.wallet[c].normal;
      if (t) t.value = state.wallet[c].tauforged;
      if (a) a.checked = !!state.wallet[c].canFuseAscent;
    });
    $('chk-coalescent').checked = !!state.canFuseCoalescent;
    $('sel-forma').value = state.forma === 'any' ? 'any' : String(state.forma);
    $('inp-umbra').value = state.umbraForma;
    Object.keys(SITE.setBonuses.sets).forEach(function (s) {
      var inp = $('setcount-' + s);
      if (inp) inp.value = state.supportSetPieces[s] || '';
    });
    $('inp-owner-health').value = state.ownerStats.health;
    $('inp-owner-shield').value = state.ownerStats.shield;
    $('inp-owner-armor').value = state.ownerStats.armor;
    $('sel-kg-grip').value = state.parts.kitgun.grip;
    syncKitgunPartSelects();
    $('sel-kg-chamber').value = state.parts.kitgun.chamber;
    $('sel-kg-loader').value = state.parts.kitgun.loader;
    $('sel-zaw-strike').value = state.parts.zaw.strike;
    $('sel-zaw-grip').value = state.parts.zaw.grip;
    $('sel-zaw-link').value = state.parts.zaw.link;
    $('sel-amp-prism').value = state.parts.amp.prism;
    $('sel-amp-scaffold').value = state.parts.amp.scaffold;
    $('sel-amp-brace').value = state.parts.amp.brace;
    $('sel-moa-model').value = state.parts.moa.model;
    $('sel-moa-core').value = state.parts.moa.core;
    $('sel-moa-gyro').value = state.parts.moa.gyro;
    $('sel-moa-bracket').value = state.parts.moa.bracket;
    $('sel-hound-model').value = state.parts.hound.model;
    $('sel-hound-core').value = state.parts.hound.core;
    $('sel-hound-bracket').value = state.parts.hound.bracket;
    $('sel-hound-stabilizer').value = state.parts.hound.stabilizer;
    $('sel-prog-element').value = state.progenitor.element;
    $('inp-prog-percent').value = state.progenitor.percent;
  }
  function defaultPick(cat) {
    if (cat.id === 'Warframe') return 'Follie';
    if (cat.id === 'Primary') return 'Braton';
    if (cat.id === 'Melee') return 'Nikana';
    if (cat.id === 'Companion Weapon') return 'Sunika Claws';
    if (cat.id === 'Necramech') return 'Voidrig';
    if (cat.id === 'Companion') return 'Sahasa Kubrow';
    return null;
  }

  function readUIFromControls() {
    // Item / locks / attack are read under the category that was active
    // when the controls were filled; the category select's new value is
    // applied at the end so a category switch doesn't mis-file them.
    var cat = currentCat();
    if (cat.kind === 'companion') {
      var cv = $('sel-companion').value;
      if (cv) state.selections.Companion = cv;
    } else if (isFrameKind(cat.kind) || cat.kind === 'weapon') {
      var v = $('inp-item').value;
      if (itemNames(cat).indexOf(v) >= 0) state.selections[cat.id] = v;
    }
    readTargetsFromUI(state.frameTargets, 'ftgt');
    readTargetsFromUI(state.weaponTargets, 'wtgt');
    readTargetsFromUI(state.ampTargets, 'atgt');
    ROUTES_FRAME.forEach(function (r) {
      var cb = $('route-' + r.key);
      if (cb) state.routesFrame[r.key] = cb.checked;
    });
    ROUTES_WEAPON.forEach(function (r) {
      var cb = $('wroute-' + r.key);
      if (cb) state.routesWeapon[r.key] = cb.checked;
    });
    state.ampConditional = $('chk-amp-conditional').checked;
    // Ability locks for the currently selected frame
    if (cat.kind === 'frame') {
      var frame = state.selections.Warframe;
      var abilities = (SITE.frames.warframes[frame] || {}).abilities || [];
      var locks = [];
      abilities.forEach(function (a, i) {
        var cb = $('lock-' + i);
        locks.push(cb ? cb.checked : false);
      });
      if (abilities.length) state.abilityLocks[frame] = locks;
    }
    Object.keys(state.wallet).forEach(function (c) {
      var n = $('wal-' + c + '-normal'), t = $('wal-' + c + '-tauforged'), a = $('wal-' + c + '-ascent');
      if (n) state.wallet[c].normal = Math.max(0, parseInt(n.value, 10) || 0);
      if (t) state.wallet[c].tauforged = Math.max(0, parseInt(t.value, 10) || 0);
      if (a) state.wallet[c].canFuseAscent = a.checked;
    });
    state.canFuseCoalescent = $('chk-coalescent').checked;
    var fv = $('sel-forma').value;
    state.forma = fv === 'any' ? 'any' : parseInt(fv, 10);
    state.umbraForma = Math.max(0, parseInt($('inp-umbra').value, 10) || 0);
    Object.keys(SITE.setBonuses.sets).forEach(function (s) {
      var inp = $('setcount-' + s);
      if (!inp) return;
      var n = parseInt(inp.value, 10);
      if (Number.isInteger(n) && n > 0) state.supportSetPieces[s] = n;
      else delete state.supportSetPieces[s];
    });
    state.ownerStats.health = $('inp-owner-health').value;
    state.ownerStats.shield = $('inp-owner-shield').value;
    state.ownerStats.armor = $('inp-owner-armor').value;
    state.parts.kitgun.grip = $('sel-kg-grip').value;
    state.parts.kitgun.chamber = $('sel-kg-chamber').value;
    state.parts.kitgun.loader = $('sel-kg-loader').value;
    state.parts.zaw.strike = $('sel-zaw-strike').value;
    state.parts.zaw.grip = $('sel-zaw-grip').value;
    state.parts.zaw.link = $('sel-zaw-link').value;
    state.parts.amp.prism = $('sel-amp-prism').value;
    state.parts.amp.scaffold = $('sel-amp-scaffold').value;
    state.parts.amp.brace = $('sel-amp-brace').value;
    state.parts.moa.model = $('sel-moa-model').value;
    state.parts.moa.core = $('sel-moa-core').value;
    state.parts.moa.gyro = $('sel-moa-gyro').value;
    state.parts.moa.bracket = $('sel-moa-bracket').value;
    state.parts.hound.model = $('sel-hound-model').value;
    state.parts.hound.core = $('sel-hound-core').value;
    state.parts.hound.bracket = $('sel-hound-bracket').value;
    state.parts.hound.stabilizer = $('sel-hound-stabilizer').value;
    state.progenitor.element = $('sel-prog-element').value;
    var pp = parseFloat($('inp-prog-percent').value);
    if (!isNaN(pp)) state.progenitor.percent = pp;
    var atk = $('sel-attack');
    if (atk && atk.options.length) {
      state.attackByItem[currentItemKey()] = parseInt(atk.value, 10) || 0;
    }
    state.category = $('sel-category').value;
    saveState();
  }

  // ---- item viewers ---------------------------------------------------------------
  function statGrid(pairs) {
    var grid = el('div', 'statgrid');
    pairs.forEach(function (pair) {
      var cell = el('div', 'cell');
      cell.appendChild(el('b', null, pair[1] == null || pair[1] === '' ? '—' : String(pair[1])));
      cell.appendChild(el('span', null, pair[0]));
      grid.appendChild(cell);
    });
    return grid;
  }
  function damageText(dmg) {
    return Object.keys(dmg || {}).map(function (k) { return k + ' ' + fmt(dmg[k]); }).join(' · ');
  }
  // A null attack field renders as infinity when the build pipeline
  // recorded that field as infinite for this weapon (infiniteFields).
  function atkVal(entry, atk, field) {
    var v = atk[field];
    if (v == null) {
      return (entry.infiniteFields || []).indexOf(field) >= 0 ? '∞' : '—';
    }
    return fmt(v);
  }
  function attackTable(entry) {
    var wrap = el('div', 'tablewrap');
    var table = el('table', 'grid');
    var thead = el('thead');
    var htr = el('tr');
    ['Attack', 'Damage', 'Total', 'Crit %', 'Crit ×', 'Status %', 'Fire rate', 'Multishot', 'Punch through']
      .forEach(function (h) { htr.appendChild(el('th', null, h)); });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tb = el('tbody');
    (entry.Attacks || []).forEach(function (atk) {
      var total = 0;
      Object.keys(atk.Damage || {}).forEach(function (k) { total += atk.Damage[k]; });
      var tr = el('tr');
      tr.appendChild(el('td', null, atk.AttackName || 'Attack'));
      tr.appendChild(el('td', null, damageText(atk.Damage)));
      tr.appendChild(el('td', null, fmt(total)));
      tr.appendChild(el('td', null, typeof atk.CritChance === 'number' ? fmt(atk.CritChance * 100) : '—'));
      tr.appendChild(el('td', null, atkVal(entry, atk, 'CritMultiplier')));
      tr.appendChild(el('td', null, typeof atk.StatusChance === 'number' ? fmt(atk.StatusChance * 100) : '—'));
      tr.appendChild(el('td', null, atkVal(entry, atk, 'FireRate')));
      tr.appendChild(el('td', null, atkVal(entry, atk, 'Multishot')));
      tr.appendChild(el('td', null, atkVal(entry, atk, 'PunchThrough')));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    return wrap;
  }
  function renderWeaponViewer(box, name, entry) {
    box.appendChild(statGrid([
      ['Class', entry.Class], ['Slot', entry.Slot], ['Family', entry.Family],
      ['Magazine', entry.Magazine], ['Reload (s)', entry.Reload],
      ['Disposition', entry.Disposition], ['Max rank', entry.MaxRank],
      ['Polarities', (entry.Polarities || []).join(', ') || 'None'],
      ['Stance polarity', entry.StancePolarity || '—'],
      ['Exilus polarity', entry.ExilusPolarity || '—']
    ]));
    if (entry.ModularParts) {
      var parts = Object.keys(entry.ModularParts).filter(function (k) {
        return ['family', 'handed'].indexOf(k) < 0;
      }).map(function (k) { return k + ': ' + entry.ModularParts[k]; }).join(' · ');
      box.appendChild(el('p', 'muted', 'Assembled from parts — ' + parts));
    }
    box.appendChild(el('h3', null, 'Attacks (max rank, unmodded)'));
    box.appendChild(attackTable(entry));
  }
  function renderViewer() {
    var cat = currentCat();
    var box = $('item-viewer');
    box.innerHTML = '';
    var nameEl = $('item-name');
    try {
      if (cat.kind === 'frame') {
        var fname = state.selections.Warframe;
        var f = fname && SITE.frames.warframes[fname];
        nameEl.textContent = f ? fname : 'No frame selected';
        if (!f) return;
        box.appendChild(statGrid([
          ['Health', f.health], ['Shield', f.shield], ['Armor', f.armor],
          ['Energy', f.energy], ['Sprint speed', f.sprintSpeed],
          ['Aura polarity', f.auraPolarity || 'None'],
          ['Innate polarities', (f.polarities || []).join(', ') || 'None']
        ]));
        box.appendChild(el('h3', null, 'Abilities'));
        var ul = el('ul', 'plain');
        (f.abilities || []).forEach(function (a) { ul.appendChild(el('li', null, a)); });
        box.appendChild(ul);
      } else if (cat.kind === 'necramech') {
        var mname = state.selections.Necramech;
        var m = mname && SITE.frames.necramechs[mname];
        nameEl.textContent = m ? mname : 'No Necramech selected';
        if (!m) return;
        box.appendChild(statGrid([
          ['Health', m.Health], ['Shield', m.Shield], ['Armor', m.Armor],
          ['Energy', m.Energy], ['Max rank', m.MaxRank],
          ['Innate polarities', (m.Polarities || []).join(', ') || 'None']
        ]));
        box.appendChild(el('h3', null, 'Abilities'));
        var ul2 = el('ul', 'plain');
        (m.Abilities || []).forEach(function (a) { ul2.appendChild(el('li', null, a)); });
        box.appendChild(ul2);
      } else if (cat.kind === 'companion') {
        var c = currentCompanion();
        var store = companionStoreEntry();
        nameEl.textContent = c ? c.frameName : 'No companion selected';
        if (!c) return;
        if (c.companionEntry) {
          var ce = c.companionEntry;
          box.appendChild(statGrid([
            ['Health', fmt(ce.Health)], ['Shield', fmt(ce.Shield)], ['Armor', fmt(ce.Armor)],
            ['Type', ce.Type], ['Polarities', (ce.Polarities || []).join(', ') || 'None'],
            ['Parts', Object.keys(ce.ModularParts || {}).map(function (k) {
              return k + ': ' + ce.ModularParts[k];
            }).join(' · ')]
          ]));
          if (ce.Precepts && ce.Precepts.length) {
            box.appendChild(el('h3', null, 'Precepts'));
            var ul3 = el('ul', 'plain');
            ce.Precepts.forEach(function (p) { ul3.appendChild(el('li', null, p)); });
            box.appendChild(ul3);
          }
          if (ce.Weapon) box.appendChild(el('p', 'muted', 'Weapon: ' + ce.Weapon + ' (solve it under Companion Weapon).'));
        } else {
          box.appendChild(statGrid([
            ['Health', store.Health], ['Shield', store.Shield], ['Armor', store.Armor],
            ['Energy', store.Energy], ['Type', store.Type], ['Category', store.Category],
            ['Polarities', (store.Polarities || []).join(', ') || 'None']
          ]));
        }
      } else if (isWeaponKind(cat.kind)) {
        var w = currentWeapon();
        nameEl.textContent = w ? w.name : 'No weapon selected';
        if (!w) return;
        renderWeaponViewer(box, w.name, w.entry);
      } else if (cat.kind === 'amp') {
        var amp = currentAmp();
        nameEl.textContent = amp.Name;
        box.appendChild(statGrid([
          ['Energy pool', amp.Magazine], ['Recharge time (s)', amp.Reload],
          ['Recharge delay (s)', amp.ReloadDelay], ['Recharge rate', amp.ReloadRate],
          ['Parts', 'prism: ' + state.parts.amp.prism + ' · scaffold: ' +
            state.parts.amp.scaffold + ' · brace: ' + state.parts.amp.brace]
        ]));
        box.appendChild(el('h3', null, 'Attacks (prism fire, then scaffold fire)'));
        box.appendChild(attackTable(amp));
      }
    } catch (e) {
      nameEl.textContent = 'Viewer error';
      box.appendChild(el('p', 'muted', e.message));
    }
  }

  // ---- category-driven UI refresh ---------------------------------------------------
  function refreshPicker() {
    var cat = currentCat();
    var namePick = (isFrameKind(cat.kind) || cat.kind === 'weapon') && cat.kind !== 'companion';
    $('item-picker-block').hidden = !namePick;
    $('companion-picker-block').hidden = cat.kind !== 'companion';
    // Part pickers are strictly contextual: each family shows only inside
    // its own category (companion groups only for their modular type).
    $('parts-kitgun').hidden = cat.kind !== 'kitgun';
    $('parts-zaw').hidden = cat.kind !== 'zaw';
    $('parts-amp').hidden = cat.kind !== 'amp';
    if (cat.kind === 'companion') {
      migrateCompanionSelection();
      var sel = $('sel-companion');
      var opts = companionOptions();
      sel.innerHTML = '';
      opts.forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0];
        o.textContent = pair[1];
        sel.appendChild(o);
      });
      var valid = opts.some(function (pair) { return pair[0] === state.selections.Companion; });
      if (!valid) state.selections.Companion = defaultPick(cat);
      sel.value = state.selections.Companion;
    }
    var ctype = cat.kind === 'companion' ? companionType() : null;
    $('parts-companion').hidden = !ctype;
    $('moa-parts').hidden = ctype !== 'MOA';
    $('hound-parts').hidden = ctype !== 'Hound';
    if (namePick) {
      $('item-picker-label').textContent = cat.id;
      var dl = $('item-list');
      dl.innerHTML = '';
      var names = itemNames(cat);
      names.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n;
        dl.appendChild(o);
      });
      var cur = state.selections[cat.id];
      if (!cur || names.indexOf(cur) < 0) {
        state.selections[cat.id] = names.indexOf(defaultPick(cat)) >= 0 ? defaultPick(cat) : names[0];
      }
      $('inp-item').value = state.selections[cat.id] || '';
    }
    // Attack selector + progenitor block for weapon kinds
    var showAttack = false, showProg = false;
    if (isWeaponKind(cat.kind)) {
      var w = null;
      try { w = currentWeapon(); } catch (e) { w = null; }
      if (w && w.entry.Attacks && w.entry.Attacks.length > 1) {
        showAttack = true;
        var sel = $('sel-attack');
        sel.innerHTML = '';
        w.entry.Attacks.forEach(function (a, i) {
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = (a.AttackName || ('Attack ' + (i + 1)));
          sel.appendChild(o);
        });
        sel.value = String(currentAttackIndex(w.entry));
      }
      if (w && w.entry.IsLichWeapon) showProg = true;
    }
    if (cat.kind === 'amp') {
      var amp = null;
      try { amp = currentAmp(); } catch (e) { amp = null; }
      if (amp && amp.Attacks.length > 1) {
        showAttack = true;
        var sel2 = $('sel-attack');
        sel2.innerHTML = '';
        amp.Attacks.forEach(function (a, i) {
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = (a.AttackName || ('Attack ' + (i + 1)));
          sel2.appendChild(o);
        });
        sel2.value = String(currentAttackIndex(amp));
      }
    }
    $('attack-block').hidden = !showAttack;
    $('progenitor-block').hidden = !showProg;
    var hints = {
      frame: 'Final builds at max rank. Ability locks for the Helminth route live on the Routes & Resources tab.',
      necramech: 'Necramechs solve from their own mod pool: 12 slots, capacity = rank cap x 2.',
      companion: 'Companion bodies solve survivability/bond mods (10 slots). Link mods scale off the owner stats on the Routes tab.',
      weapon: 'Paper stats for the selected attack. Catalyst capacity is assumed.',
      kitgun: 'You pick the parts; the solver works out the mods. Grip decides Primary vs Secondary.',
      zaw: 'You pick the parts; the solver works out the mods.',
      amp: 'Amps take no mods — Calculate solves Operator/Amp arcanes only.'
    };
    $('item-hint').textContent = hints[cat.kind] || '';
  }

  function refreshTargets() {
    var cat = currentCat();
    $('targets-frame-wrap').hidden = !isFrameKind(cat.kind);
    $('targets-weapon-wrap').hidden = !isWeaponKind(cat.kind);
    $('targets-amp-wrap').hidden = cat.kind !== 'amp';
    if (cat.kind === 'companion') {
      // Companion solves use the pool-stat subset of the frame table.
      FRAME_STATS.forEach(function (s) {
        var row = $('ftgt-mode-' + s.key);
        if (!row) return;
        var tr = row.closest('tr');
        if (tr) tr.style.display = COMPANION_STATS.indexOf(s) >= 0 ? '' : 'none';
      });
    } else {
      FRAME_STATS.forEach(function (s) {
        var mode = $('ftgt-mode-' + s.key);
        if (!mode) return;
        var tr = mode.closest('tr');
        if (tr) tr.style.display = '';
      });
    }
  }

  function refreshRoutes() {
    var cat = currentCat();
    var framePanel = isFrameKind(cat.kind);
    $('routes-frame-panel').hidden = !framePanel;
    $('routes-weapon-panel').hidden = !isWeaponKind(cat.kind);
    $('routes-amp-panel').hidden = cat.kind !== 'amp';
    $('routes-companion-panel').hidden = cat.kind !== 'companion';
    $('sets-panel').hidden = cat.kind !== 'frame';
    $('wallet-panel').hidden = cat.kind !== 'frame';
    $('forma-panel').hidden = cat.kind === 'amp';
    if (framePanel) {
      ROUTES_FRAME.forEach(function (r) {
        var wrap = $('route-wrap-' + r.key);
        if (!wrap) return;
        var show = cat.kind === 'frame' || SUBSET_KIND_ROUTES.indexOf(r.key) >= 0;
        wrap.style.display = show ? '' : 'none';
      });
      $('helminth-block').hidden = !(cat.kind === 'frame' && state.routesFrame.helminth);
      if (cat.kind === 'frame' && state.routesFrame.helminth) buildLockChecks();
    }
  }

  function buildLockChecks() {
    var frame = state.selections.Warframe;
    var abilities = (SITE.frames.warframes[frame] || {}).abilities || [];
    var locks = state.abilityLocks[frame] || [];
    var box = $('lock-checks');
    box.innerHTML = '';
    abilities.forEach(function (a, i) {
      var lab = el('label', 'check');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'lock-' + i;
      cb.checked = !!locks[i];
      lab.appendChild(cb);
      lab.appendChild(el('span', null, 'Lock ' + a));
      box.appendChild(lab);
    });
    if (!abilities.length) box.appendChild(el('p', 'muted', 'No abilities listed for this frame.'));
  }

  function refreshCategoryUI() {
    refreshPicker();
    refreshTargets();
    refreshRoutes();
    renderViewer();
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

  // ---- solve plumbing ---------------------------------------------------------------
  var worker = null, workerSeq = 0, workerPending = {};
  function initWorker() {
    try {
      worker = new Worker('js/solve-worker.js');
      worker.onmessage = function (e) {
        var msg = e.data || {};
        var p = workerPending[msg.id];
        if (!p) return;
        delete workerPending[msg.id];
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'worker solve failed'));
      };
      worker.onerror = function () {
        // Fall back to main-thread solving from here on.
        Object.keys(workerPending).forEach(function (id) {
          workerPending[id].reject(new Error('worker failed'));
          delete workerPending[id];
        });
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
  }
  function solveMainThread(req) {
    if (req.kind === 'frame') return window.Solver.solve(req.input, req.bundle);
    if (req.kind === 'weapon') return window.WeaponSolver.solve(req.input, req.bundle);
    if (req.kind === 'amp') return window.Modular.solveAmp(req.input, req.bundle);
    throw new Error('unknown solve kind ' + req.kind);
  }
  function runSolve(req) {
    if (!worker) {
      try { return Promise.resolve(solveMainThread(req)); }
      catch (e) { return Promise.reject(e); }
    }
    return new Promise(function (resolve, reject) {
      var id = ++workerSeq;
      workerPending[id] = { resolve: resolve, reject: reject };
      try {
        worker.postMessage({ id: id, kind: req.kind, input: req.input, bundle: req.bundle });
      } catch (e) {
        delete workerPending[id];
        try { resolve(solveMainThread(req)); } catch (e2) { reject(e2); }
      }
    });
  }

  function collectTargets(store, stats) {
    var targets = {};
    stats.forEach(function (s) {
      var t = store[s.key];
      if (!t || t.mode === 'dontcare') return;
      var v = parseFloat(t.value);
      if (isNaN(v)) return;
      var entry = { mode: t.mode, value: v };
      if (s.lowerBetter) entry.lowerBetter = true;
      targets[s.key] = entry;
    });
    return targets;
  }
  function shardWalletInput() {
    var wallet = {};
    Object.keys(state.wallet).forEach(function (c) {
      wallet[c] = {
        normal: state.wallet[c].normal,
        tauforged: state.wallet[c].tauforged,
        canFuseAscent: !!state.wallet[c].canFuseAscent,
        canFuseCoalescent: !!state.canFuseCoalescent
      };
    });
    return wallet;
  }
  function supportSetsInput() {
    var out = {};
    Object.keys(state.supportSetPieces).forEach(function (s) {
      if (state.supportSetPieces[s] > 0) out[s] = state.supportSetPieces[s];
    });
    return Object.keys(out).length ? out : undefined;
  }

  function buildSolveRequest() {
    var cat = currentCat();
    if (cat.kind === 'frame') {
      var frame = state.selections.Warframe;
      if (!frame || !SITE.frames.warframes[frame]) throw new Error('Pick a valid frame first (Item tab).');
      var routes = {};
      ROUTES_FRAME.forEach(function (r) { routes[r.key] = !!state.routesFrame[r.key]; });
      return {
        kind: 'frame',
        input: {
          frameName: frame,
          targets: collectTargets(state.frameTargets, FRAME_STATS),
          routes: routes,
          abilityLocks: state.abilityLocks[frame] || [],
          shardWallet: shardWalletInput(),
          formaBudget: state.forma,
          umbraForma: state.umbraForma,
          supportSetPieces: supportSetsInput(),
          reactor: true
        },
        bundle: BUNDLE
      };
    }
    if (cat.kind === 'necramech') {
      var mech = state.selections.Necramech;
      if (!mech || !SITE.frames.necramechs[mech]) throw new Error('Pick a valid Necramech first (Item tab).');
      return {
        kind: 'frame',
        input: {
          itemKind: 'necramech',
          frameName: mech,
          targets: collectTargets(state.frameTargets, FRAME_STATS),
          routes: { mods: state.routesFrame.mods, conditional: state.routesFrame.conditional },
          formaBudget: state.forma,
          umbraForma: state.umbraForma
        },
        bundle: BUNDLE
      };
    }
    if (cat.kind === 'companion') {
      var comp = currentCompanion();
      if (!comp) throw new Error('Pick a valid companion first (Item tab).');
      var owner = null;
      var oh = parseFloat(state.ownerStats.health), os = parseFloat(state.ownerStats.shield),
          oa = parseFloat(state.ownerStats.armor);
      if (!isNaN(oh) || !isNaN(os) || !isNaN(oa)) {
        owner = { health: oh || 0, shield: os || 0, armor: oa || 0 };
      }
      var cinput = {
        itemKind: 'companion',
        frameName: comp.frameName,
        targets: collectTargets(state.frameTargets, COMPANION_STATS),
        routes: { mods: state.routesFrame.mods, conditional: state.routesFrame.conditional },
        formaBudget: state.forma,
        umbraForma: state.umbraForma
      };
      if (comp.companionEntry) cinput.companionEntry = comp.companionEntry;
      if (owner) cinput.ownerStats = owner;
      return { kind: 'frame', input: cinput, bundle: BUNDLE };
    }
    if (isWeaponKind(cat.kind)) {
      var w = currentWeapon();
      if (!w) throw new Error('Pick a valid weapon first (Item tab).');
      var wroutes = {};
      ROUTES_WEAPON.forEach(function (r) { wroutes[r.key] = !!state.routesWeapon[r.key]; });
      var winput = {
        weaponName: w.name,
        attackIndex: currentAttackIndex(w.entry),
        targets: collectTargets(state.weaponTargets, WEAPON_STATS),
        routes: wroutes,
        formaBudget: state.forma,
        umbraForma: state.umbraForma
      };
      if (w.entry.IsLichWeapon) {
        var pct = Math.min(60, Math.max(25, state.progenitor.percent || 60));
        winput.progenitor = { element: state.progenitor.element, percent: pct };
      }
      var bundle = BUNDLE;
      if (w.assembled) {
        var weapons = Object.assign({}, SITE.weapons);
        weapons[w.name] = w.entry;
        bundle = Object.assign({}, BUNDLE, { weapons: weapons });
      }
      return { kind: 'weapon', input: winput, bundle: bundle };
    }
    if (cat.kind === 'amp') {
      var amp = currentAmp();
      var targets = {};
      AMP_STATS.forEach(function (s) {
        var t = state.ampTargets[s.key];
        if (!t || t.mode === 'dontcare') return;
        var v = parseFloat(t.value);
        if (isNaN(v)) return;
        targets[s.key] = { mode: t.mode, value: s.frac ? v / 100 : v };
      });
      return {
        kind: 'amp',
        input: {
          amp: amp,
          attackIndex: currentAttackIndex(amp),
          targets: targets,
          routes: { conditional: state.ampConditional }
        },
        bundle: { arcaneEffects: SITE.arcanes }
      };
    }
    throw new Error('unsupported category');
  }

  // ---- results rendering ---------------------------------------------------------------
  function groupInto(box, title, lines) {
    if (!lines.length) return;
    var g = el('div', 'piece-group');
    g.appendChild(el('h3', null, title));
    var ul = el('ul', 'plain');
    lines.forEach(function (txt) { ul.appendChild(el('li', null, txt)); });
    g.appendChild(ul);
    box.appendChild(g);
  }
  function modRecord(name) {
    var rec = null;
    (SITE.mods.mods || []).some(function (m) { if (m.name === name) { rec = m; return true; } return false; });
    if (!rec) {
      (SITE.auras.mods || []).some(function (m) { if (m.name === name) { rec = m; return true; } return false; });
    }
    return rec;
  }
  function rankCostText(m) {
    if (!m || typeof m.rank !== 'number' || m.rank === 0) return '';
    if (m.rankCost) return ' · ' + fmtInt(m.rankCost.endo) + ' Endo / ' + fmtInt(m.rankCost.credits) + ' Credits to rank';
    return ' · rank cost unknown';
  }
  function modLine(m) {
    var rec = modRecord(m.name);
    var maxRank = rec ? rec.maxRank : '?';
    var drain = rec ? (rec.baseDrain || 0) + m.rank : null;
    return m.name + ' r' + m.rank + '/' + maxRank +
      (drain != null ? ' — drain ' + drain : '') + rankCostText(m);
  }
  function setBonusLines(setBonuses) {
    return (setBonuses || []).map(function (sb) {
      var line = sb.set + ' — ' + sb.pieces + ' piece' + (sb.pieces === 1 ? '' : 's') +
        ' (' + sb.focusPieces + ' on this item + ' + sb.supportPieces + ' support)';
      if (sb.perPiece && sb.perPiece.length === 1 && typeof sb.perPiece[0].value === 'number') {
        line += ': ' + fmt(sb.perPiece[0].value) + (sb.perPiece[0].unit === 'percent' ? '%' : '') +
          ' per piece' + (sb.totalValue != null ? ' → ' + fmt(sb.totalValue) + ' total' : '');
      }
      if (sb.applied) line += ' — applied';
      else if (sb.parseStatus && sb.parseStatus !== 'parsed') line += ' — not modelled (prose effect)';
      return line;
    });
  }
  function achievedTable(stats, store, achieved, unmetTargets, fracStats) {
    var tb = $('achieved-table').querySelector('tbody');
    tb.innerHTML = '';
    var unmet = {};
    (unmetTargets || []).forEach(function (u) { unmet[u.stat] = true; });
    stats.forEach(function (s) {
      var t = store[s.key];
      var tr = el('tr');
      tr.appendChild(el('td', null, s.label));
      var targetText = '—';
      if (t && t.mode === 'atleast') targetText = (s.lowerBetter ? '≤ ' : '≥ ') + t.value;
      if (t && t.mode === 'closest') targetText = '≈ ' + t.value;
      tr.appendChild(el('td', null, targetText));
      var ach = achieved ? achieved[s.key] : null;
      var achDisp = ach;
      if (fracStats && s.frac && typeof ach === 'number') achDisp = ach * 100;
      tr.appendChild(el('td', null, ach == null ? '—' : fmt(achDisp)));
      var status = '—', cls = '';
      if (t && t.mode === 'atleast' && typeof ach === 'number') {
        var met = !unmet[s.key];
        status = met ? 'met' : 'unmet';
        cls = met ? 'status-met' : 'status-unmet';
      } else if (t && t.mode === 'closest' && typeof ach === 'number') {
        var tv = parseFloat(t.value);
        var av = fracStats && s.frac ? ach * 100 : ach;
        var d = Math.abs(av - tv);
        status = d < 1e-9 ? 'met' : 'off by ' + fmt(d);
        cls = d < 1e-9 ? 'status-met' : '';
      }
      tr.appendChild(el('td', cls, status));
      tb.appendChild(tr);
    });
  }
  function renderNotes(res) {
    var notes = $('result-notes');
    notes.innerHTML = '';
    (res.notes || []).forEach(function (n) { notes.appendChild(el('li', null, n)); });
    if (!(res.notes || []).length) notes.appendChild(el('li', null, 'All targets met.'));
  }

  function renderFrameArrangement(box, res, compact, collect) {
    var arr = res.arrangement;
    var normal = arr.mods.filter(function (m) { return m.slot !== 'exilus'; });
    var exilus = arr.mods.filter(function (m) { return m.slot === 'exilus'; });
    groupInto(box, 'Mods', normal.map(modLine));
    groupInto(box, 'Exilus', exilus.map(modLine));
    if (arr.aura) {
      var aRec = modRecord(arr.aura);
      var aMax = aRec ? (aRec.maxRank || 0) : 0;
      var aDrain = aRec ? Math.abs(aRec.baseDrain || 0) + aMax : null;
      groupInto(box, 'Aura', [arr.aura + ' r' + aMax + '/' + aMax +
        (aDrain != null ? ' — capacity +' + aDrain + ' (drain ' + (aRec.baseDrain || 0) + ' at max rank)' : '')]);
    }
    groupInto(box, 'Arcanes', arr.arcanes || []);
    groupInto(box, 'Archon Shards', (arr.shards || []).map(function (s) {
      return s.colour + ' Archon Shard (' + s.tier + ') — ' + (FRAME_LABEL[s.stat] || s.stat);
    }));
    if (!compact) {
      var fusions = (res.notes || []).filter(function (n) { return n.indexOf('Fusion:') >= 0; });
      groupInto(box, 'Shard fusions used', fusions);
    }
    if (arr.helmet) groupInto(box, 'Legacy Arcane Helmet', [arr.helmet]);
    if (arr.tome) groupInto(box, 'Tome mod (cross-gear, support item treated as already built)', [arr.tome]);
    if (arr.subsume) {
      groupInto(box, 'Helminth subsume', [
        arr.subsume.ability + ' (from ' + arr.subsume.fromFrame + ') replaces ' + arr.subsume.replacedAbility
      ]);
    }
    groupInto(box, 'Set bonuses (focus + support pieces)', setBonusLines(res.setBonuses));
    if (collect) {
      normal.forEach(function (m) { collect.push({ name: m.name, kind: 'Mod' }); });
      exilus.forEach(function (m) { collect.push({ name: m.name, kind: 'Exilus mod' }); });
      if (arr.aura) collect.push({ name: arr.aura, kind: 'Aura' });
      (arr.arcanes || []).forEach(function (n) { collect.push({ name: n, kind: 'Arcane' }); });
      (arr.shards || []).forEach(function (s) {
        collect.push({ name: s.colour + ' Archon Shard', kind: 'Archon Shard (' + s.tier + ', ' + (FRAME_LABEL[s.stat] || s.stat) + ')' });
      });
      if (arr.helmet) collect.push({ name: arr.helmet, kind: 'Legacy Arcane Helmet' });
      if (arr.tome) collect.push({ name: arr.tome, kind: 'Tome mod (cross-gear)' });
      if (arr.subsume) collect.push({ name: arr.subsume.ability, kind: 'Subsumed ability (from ' + arr.subsume.fromFrame + ')' });
    }
  }

  function renderWeaponArrangement(box, res, compact, collect) {
    var arr = res.arrangement;
    var normal = arr.mods.filter(function (m) { return m.slot !== 'exilus'; });
    var exilus = arr.mods.filter(function (m) { return m.slot === 'exilus'; });
    groupInto(box, 'Mods', normal.map(modLine));
    groupInto(box, 'Exilus', exilus.map(modLine));
    if (arr.stance) groupInto(box, 'Stance / posture', [arr.stance]);
    if (arr.arcane) groupInto(box, 'Arcane', [arr.arcane]);
    groupInto(box, 'Set bonuses (focus + support pieces)', setBonusLines(res.setBonuses));
    if (collect) {
      normal.forEach(function (m) { collect.push({ name: m.name, kind: 'Mod' }); });
      exilus.forEach(function (m) { collect.push({ name: m.name, kind: 'Exilus mod' }); });
      if (arr.stance) collect.push({ name: arr.stance, kind: 'Stance' });
      if (arr.arcane) collect.push({ name: arr.arcane, kind: 'Arcane' });
    }
  }

  function formaPlanText(arr, weaponKind) {
    if (!arr.formaPlan || !arr.formaPlan.length) return '';
    return 'Forma plan: ' + arr.formaPlan.map(function (f) {
      var slot = weaponKind && f.slot >= 8 ? 'exilus slot' : 'slot ' + (f.slot + 1);
      return slot + ' → ' + f.polarity + (f.umbra ? ' (Umbra Forma)' : '');
    }).join('; ');
  }

  function renderResults(kind, res) {
    lastResult = res;
    lastKind = kind;
    lastPieces = [];
    $('results-empty').hidden = true;
    $('results-body').hidden = false;
    var cat = currentCat();
    var arr = res.arrangement || {};
    renderNotes(res);
    var box = $('arrangement');
    box.innerHTML = '';
    var dmg = $('damage-line');
    dmg.innerHTML = '';
    if (kind === 'frame') {
      var stats = cat.kind === 'companion' ? COMPANION_STATS : FRAME_STATS;
      achievedTable(stats, state.frameTargets, res.achieved, res.unmetTargets, false);
      renderFrameArrangement(box, res, false, lastPieces);
      $('capacity-line').textContent =
        'Mod capacity: ' + arr.capacityUsed + ' / ' + arr.capacityMax +
        ' · Forma used: ' + arr.formaUsed +
        (arr.umbraFormaUsed ? ' · Umbra Forma used: ' + arr.umbraFormaUsed : '');
      $('cost-line').textContent = res.totalRankCost
        ? 'Ranking cost to the solved ranks: ' + fmtInt(res.totalRankCost.endo) + ' Endo / ' +
          fmtInt(res.totalRankCost.credits) + ' Credits'
        : '';
      $('forma-line').innerHTML = '';
      var fp = formaPlanText(arr, false);
      if (fp) $('forma-line').appendChild(el('p', null, fp));
    } else if (kind === 'weapon') {
      achievedTable(WEAPON_STATS, state.weaponTargets, res.achieved, res.unmetTargets, false);
      // Modular parts are build pieces too.
      if (cat.kind === 'kitgun') {
        lastPieces.push({ name: state.parts.kitgun.chamber, kind: 'Part (Chamber)' });
        lastPieces.push({ name: state.parts.kitgun.grip, kind: 'Part (Grip)' });
        lastPieces.push({ name: state.parts.kitgun.loader, kind: 'Part (Loader)' });
      }
      if (cat.kind === 'zaw') {
        lastPieces.push({ name: state.parts.zaw.strike, kind: 'Part (Strike)' });
        lastPieces.push({ name: state.parts.zaw.grip, kind: 'Part (Grip)' });
        lastPieces.push({ name: state.parts.zaw.link, kind: 'Part (Link)' });
      }
      renderWeaponArrangement(box, res, false, lastPieces);
      if (res.forward && res.forward.damageByType) {
        var pairs = Object.keys(res.forward.damageByType).map(function (k) {
          return [k, fmt(res.forward.damageByType[k])];
        });
        pairs.push(['Total per pellet', fmt(res.forward.totalDamage)]);
        pairs.push(['Damage per shot', fmt(res.forward.damagePerShot)]);
        if (res.forward.factionMultiplier && res.forward.factionMultiplier !== 1) {
          pairs.push(['Faction multiplier', '×' + fmt(res.forward.factionMultiplier)]);
          pairs.push(['Faction-adjusted damage', fmt(res.forward.factionAdjustedDamage)]);
        }
        dmg.appendChild(el('h3', null, 'Damage breakdown (solved build, selected attack)'));
        dmg.appendChild(statGrid(pairs));
      }
      $('capacity-line').textContent =
        'Mod capacity: ' + arr.capacityUsed + ' / ' + arr.capacityMax +
        ' · Forma used: ' + arr.formaUsed +
        (arr.overRankForma ? ' (incl. ' + arr.overRankForma + ' over-rank)' : '') +
        (arr.umbraFormaUsed ? ' · Umbra Forma used: ' + arr.umbraFormaUsed : '');
      $('cost-line').textContent = res.totalRankCost
        ? 'Ranking cost to the solved ranks: ' + fmtInt(res.totalRankCost.endo) + ' Endo / ' +
          fmtInt(res.totalRankCost.credits) + ' Credits'
        : '';
      $('forma-line').innerHTML = '';
      var fp2 = formaPlanText(arr, true);
      if (fp2) $('forma-line').appendChild(el('p', null, fp2));
    } else if (kind === 'amp') {
      achievedTable(AMP_STATS, state.ampTargets, res.achieved, res.unmetTargets, true);
      lastPieces.push({ name: state.parts.amp.prism, kind: 'Amp part (Prism)' });
      lastPieces.push({ name: state.parts.amp.scaffold, kind: 'Amp part (Scaffold)' });
      lastPieces.push({ name: state.parts.amp.brace, kind: 'Amp part (Brace)' });
      groupInto(box, 'Amp arcanes', res.arcanes.amp || []);
      groupInto(box, 'Operator arcanes', res.arcanes.operator || []);
      (res.arcanes.amp || []).forEach(function (n) { lastPieces.push({ name: n, kind: 'Amp arcane' }); });
      (res.arcanes.operator || []).forEach(function (n) { lastPieces.push({ name: n, kind: 'Operator arcane' }); });
      if (res.achieved && res.achieved.damageByType) {
        var pairs2 = Object.keys(res.achieved.damageByType).map(function (k) {
          return [k, fmt(res.achieved.damageByType[k])];
        });
        dmg.appendChild(el('h3', null, 'Damage breakdown (solved build, selected attack)'));
        dmg.appendChild(statGrid(pairs2));
      }
      $('capacity-line').textContent = 'Amps take no mods — no capacity, Forma, or ranking costs.';
      $('cost-line').textContent = '';
      $('forma-line').innerHTML = '';
    }
    // Cheapest variant
    var cp = $('cheapest-panel');
    if (res.cheapest) {
      cp.hidden = false;
      var cbox = $('cheapest-body');
      cbox.innerHTML = '';
      if (kind === 'frame') renderFrameArrangement(cbox, res.cheapest, true, null);
      else if (kind === 'weapon') renderWeaponArrangement(cbox, res.cheapest, true, null);
      var ca = res.cheapest.arrangement || {};
      var line = 'Capacity: ' + ca.capacityUsed + ' / ' + ca.capacityMax +
        ' · Forma used: ' + ca.formaUsed +
        (ca.overRankForma ? ' (incl. ' + ca.overRankForma + ' over-rank)' : '') +
        (ca.umbraFormaUsed ? ' · Umbra Forma used: ' + ca.umbraFormaUsed : '');
      if (res.cheapest.totalRankCost) {
        line += ' · Ranking cost: ' + fmtInt(res.cheapest.totalRankCost.endo) + ' Endo / ' +
          fmtInt(res.cheapest.totalRankCost.credits) + ' Credits';
      }
      cbox.appendChild(el('p', null, line));
    } else {
      cp.hidden = true;
    }
    if (!box.children.length) box.appendChild(el('p', 'muted', 'Empty build — no pieces needed for the current targets.'));
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
    refreshCategoryUI();
    var req;
    try {
      req = buildSolveRequest();
    } catch (e) {
      $('calc-status').textContent = e.message;
      showTab('item');
      return;
    }
    var btn = $('btn-calc');
    btn.disabled = true;
    btn.textContent = 'Calculating…';
    $('calc-status').textContent = 'Calculating…';
    runSolve(req).then(function (res) {
      renderResults(req.kind, res);
      $('calc-status').textContent = '';
      showTab('results');
    }).catch(function (e) {
      $('calc-status').textContent = 'Solver error: ' + e.message;
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Calculate';
    });
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
      fetchJSON('data/frames.json'), fetchJSON('data/weapons.json'),
      fetchJSON('data/mods.json'), fetchJSON('data/arcanes.json'),
      fetchJSON('data/tomes.json'), fetchJSON('data/auras.json'),
      fetchJSON('data/shards.json'), fetchJSON('data/helmets.json'),
      fetchJSON('data/modular.json'), fetchJSON('data/helminth.json'),
      fetchJSON('data/set_bonuses.json'), fetchJSON('data/links.json'),
      fetchJSON('data/acquisition.json')
    ]).then(function (parts) {
      SITE = {
        frames: parts[0], weapons: parts[1], mods: parts[2], arcanes: parts[3],
        tomes: parts[4], auras: parts[5], shards: parts[6], helmets: parts[7],
        modular: parts[8], helminth: parts[9], setBonuses: parts[10],
        links: parts[11], acquisition: parts[12]
      };
      BUNDLE = assembleBundle(SITE);
      state = defaultState();
      // Share-link state wins over localStorage.
      state = mergeState(state, decodeHash() || loadSaved());
      buildControls();
      applyStateToUI();
      refreshCategoryUI();
      initWorker();

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
      document.querySelector('main').addEventListener('change', function (e) {
        readUIFromControls();
        if (e.target && e.target.id === 'sel-kg-grip') {
          syncKitgunPartSelects();
          readUIFromControls();
        }
        refreshCategoryUI();
        saveState();
      });
      $('inp-item').addEventListener('input', function () {
        var cat = currentCat();
        if (itemNames(cat).indexOf($('inp-item').value) >= 0) {
          readUIFromControls();
          refreshCategoryUI();
          saveState();
        }
      });
      renderAcquisition();
    }).catch(function (e) {
      $('calc-status').textContent = 'Failed to load site data: ' + e.message;
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
