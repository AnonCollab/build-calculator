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
 *
 * v1.1 (E2): Maximize targets + priorities, damage-type targets
 * (dmg:<Type>), per-category mod/arcane locks over the FULL mod pool
 * (data/modpool.json), and the Results build board: an editable,
 * slot-ordered rendering of arrangement.slots whose every edit is
 * re-scored by the solvers' own forward evaluators
 * (Solver.evaluateFrame / WeaponSolver.evaluateWeapon).
 *
 * v1.2 (F2): Helminth forced choice (donor + replaced ability, with
 * a Results instruction card for non-modelled donors), per-category
 * mod/arcane EXCLUDES beside the locks (bans bind the solve; the
 * board gains "Ban this mod"), prescriptive cross-gear planning
 * (the support set-piece count inputs are gone — the solver plans
 * named mods on named gear and counts them immediately), and
 * per-stat breakdown chains on the achieved table, driven by the
 * solvers'/evaluators' `breakdown` field.
 *
 * v1.3 (G3): build intent (Window / Upkeep) inside the conditional
 * route — state v5 carries `intent`, solve requests pass it always
 * (the engines consult it only with the conditional route on, using
 * the shipped data/conditional_classes.json, which the bundle now
 * also carries). Results gain the sustained-floor lines (Peak vs
 * burst-down values) and the "How to get the most out of this build"
 * guide, rendered from the live board's conditional pieces.
 *
 * v1.4 (site): restricted-pool surfacing — picker lists now honour
 * the shipped records' `restrictedTo` (a restricted mod appears only
 * on its own item) and ability augments appear only with the new
 * Augments route ON and only where the engine's shared
 * Solver.augmentEligible admits them for the current frame +
 * Helminth choice (eligibility follows the ability, live). Hybrid
 * intent joins the intent selects with a burst-allowance select;
 * state v6 carries routes.augments + hybridAllowance.
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
  // Damage-type targets (v1.1): weaponSolver stat keys 'dmg:<Type>' —
  // final per-shot amount of each type after combining.
  var DMG_TYPES = ['Impact', 'Puncture', 'Slash', 'Heat', 'Cold',
    'Electric', 'Toxin', 'Blast', 'Corrosive', 'Gas', 'Magnetic',
    'Radiation', 'Viral', 'Void'];
  var DMG_STATS = DMG_TYPES.map(function (t) {
    return { key: 'dmg:' + t, label: t };
  });
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
    { key: 'augments', label: 'Ability augments', def: false },
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
      legacyHelmets: site.helmets,
      conditionalClasses: site.conditionalClasses
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
    stats.forEach(function (s) { t[s.key] = { mode: 'dontcare', value: '', priority: '' }; });
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
      version: 6,
      category: 'Warframe',
      intent: 'window',
      // v1.4: Hybrid burst allowance (1 | 2). routesFrame.augments
      // (the Augments route) rides with the other route toggles.
      hybridAllowance: 1,
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
      dmgTargets: emptyTargets(DMG_STATS),
      ampTargets: emptyTargets(AMP_STATS),
      // v1.1: per-category locks {catId: {mods: [{name, rank}],
      // arcanes: [name]}} and the current board (see serializeBoard).
      locks: {},
      // v1.2: per-category excludes {catId: {mods: [name],
      // arcanes: [name]}} — the ban half of piece control.
      excludes: {},
      // v1.2: Helminth forced choice (frame category): mode
      // 'auto' (solver chooses) | 'choose' (player pins the donor).
      helminthMode: 'auto',
      helminthChoice: { donor: '', replacesIndex: 0 },
      // v1.2: prescriptive cross-gear planning. on = the route
      // toggle; include = [{mod}] forced into the plan; exclude =
      // [setOrModName] kept out of it. (The v1.0–v1.1 support
      // set-piece counts are gone; old saves drop them.)
      crossGear: { on: true, include: [], exclude: [] },
      board: null,
      routesFrame: routesFrame,
      routesWeapon: routesWeapon,
      ampConditional: true,
      abilityLocks: {},
      wallet: wallet,
      canFuseCoalescent: false,
      forma: 'any',
      umbraForma: 0,
      ownerStats: { health: '', shield: '', armor: '' },
      progenitor: { element: 'Heat', percent: 60 }
    };
  }

  function mergeTargets(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.keys(base).forEach(function (k) {
      var t = saved[k];
      if (t && typeof t === 'object') {
        if (['dontcare', 'closest', 'atleast', 'maximize'].indexOf(t.mode) >= 0) base[k].mode = t.mode;
        if (t.value != null) base[k].value = t.value;
        if (t.priority != null) base[k].priority = t.priority;
      }
    });
  }
  // v1.1 saved locks: {catId: {mods: [{name, rank}], arcanes: [name]}} —
  // shape-checked entry by entry; anything malformed is dropped.
  function mergeLocks(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.keys(saved).forEach(function (catId) {
      var L = saved[catId];
      if (!L || typeof L !== 'object') return;
      var entry = { mods: [], arcanes: [] };
      (Array.isArray(L.mods) ? L.mods : []).forEach(function (m) {
        if (m && typeof m.name === 'string') {
          var r = parseInt(m.rank, 10);
          entry.mods.push({ name: m.name, rank: Number.isInteger(r) && r >= 0 ? r : 0 });
        }
      });
      (Array.isArray(L.arcanes) ? L.arcanes : []).forEach(function (n) {
        if (typeof n === 'string') entry.arcanes.push(n);
      });
      if (entry.mods.length || entry.arcanes.length) base[catId] = entry;
    });
  }
  // v1.2 saved excludes: {catId: {mods: [name], arcanes: [name]}} —
  // same per-category shape discipline as the locks.
  function mergeExcludes(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    Object.keys(saved).forEach(function (catId) {
      var X = saved[catId];
      if (!X || typeof X !== 'object') return;
      var entry = { mods: [], arcanes: [] };
      (Array.isArray(X.mods) ? X.mods : []).forEach(function (n) {
        if (typeof n === 'string' && entry.mods.indexOf(n) < 0) entry.mods.push(n);
      });
      (Array.isArray(X.arcanes) ? X.arcanes : []).forEach(function (n) {
        if (typeof n === 'string' && entry.arcanes.indexOf(n) < 0) entry.arcanes.push(n);
      });
      if (entry.mods.length || entry.arcanes.length) base[catId] = entry;
    });
  }
  // v1.2 saved cross-gear: {on, include: [{mod}], exclude: [name]}.
  function mergeCrossGear(base, saved) {
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.on === 'boolean') base.on = saved.on;
    (Array.isArray(saved.include) ? saved.include : []).forEach(function (e) {
      var name = e && typeof e.mod === 'string' ? e.mod : null;
      if (name && !base.include.some(function (x) { return x.mod === name; })) {
        base.include.push({ mod: name });
      }
    });
    (Array.isArray(saved.exclude) ? saved.exclude : []).forEach(function (n) {
      if (typeof n === 'string' && base.exclude.indexOf(n) < 0) base.exclude.push(n);
    });
  }
  // v1.1 saved board: {kind, catId, itemKey, slots: [{kind, mod, rank}],
  // extras} — kept only when every slot is shape-valid.
  function mergeBoard(saved) {
    if (!saved || typeof saved !== 'object') return null;
    if (saved.kind !== 'frame' && saved.kind !== 'weapon') return null;
    if (typeof saved.catId !== 'string' || typeof saved.itemKey !== 'string') return null;
    if (!Array.isArray(saved.slots) || !saved.slots.length) return null;
    var kinds = { aura: 1, stance: 1, normal: 1, exilus: 1 };
    var slots = [];
    for (var i = 0; i < saved.slots.length; i++) {
      var s = saved.slots[i];
      if (!s || !kinds[s.kind]) return null;
      if (s.mod != null && typeof s.mod !== 'string') return null;
      var r = s.rank == null ? null : parseInt(s.rank, 10);
      if (r != null && (!Number.isInteger(r) || r < 0)) return null;
      slots.push({ kind: s.kind, mod: s.mod || null, rank: r });
    }
    return {
      kind: saved.kind, catId: saved.catId, itemKey: saved.itemKey,
      slots: slots,
      extras: (saved.extras && typeof saved.extras === 'object') ? saved.extras : {}
    };
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
      if (saved.version === 2 || saved.version === 3 || saved.version === 4 || saved.version === 5 || saved.version === 6) {
        if (catOf(saved.category).id === saved.category) base.category = saved.category;
        // v1.3: intent arrived in state v5; v2–v4 saves keep the
        // default 'window' (the engines' unset behaviour). v1.4:
        // 'hybrid' joins the legal values with state v6.
        if (saved.intent === 'window' || saved.intent === 'upkeep' || saved.intent === 'hybrid') base.intent = saved.intent;
        // v1.4: hybridAllowance arrived in state v6; v5 and older
        // saves keep the default 1. routes.augments needs no line
        // here — mergeRoutes below carries it (default off).
        if (saved.hybridAllowance === 2) base.hybridAllowance = 2;
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
        mergeTargets(base.dmgTargets, saved.dmgTargets);
        mergeTargets(base.ampTargets, saved.ampTargets);
        mergeLocks(base.locks, saved.locks);
        mergeExcludes(base.excludes, saved.excludes);
        if (saved.helminthMode === 'choose' || saved.helminthMode === 'auto') {
          base.helminthMode = saved.helminthMode;
        }
        if (saved.helminthChoice && typeof saved.helminthChoice === 'object') {
          if (typeof saved.helminthChoice.donor === 'string') {
            base.helminthChoice.donor = saved.helminthChoice.donor;
          }
          var hri = parseInt(saved.helminthChoice.replacesIndex, 10);
          if (Number.isInteger(hri) && hri >= 0 && hri <= 3) {
            base.helminthChoice.replacesIndex = hri;
          }
        }
        mergeCrossGear(base.crossGear, saved.crossGear);
        base.board = mergeBoard(saved.board);
        mergeRoutes(base.routesFrame, saved.routesFrame);
        mergeRoutes(base.routesWeapon, saved.routesWeapon);
        if (typeof saved.ampConditional === 'boolean') base.ampConditional = saved.ampConditional;
        if (saved.abilityLocks && typeof saved.abilityLocks === 'object') {
          Object.keys(saved.abilityLocks).forEach(function (f) {
            var a = saved.abilityLocks[f];
            if (Array.isArray(a)) base.abilityLocks[f] = a.map(function (x) { return !!x; });
          });
        }
        // v1.0–v1.1 support set-piece counts are deliberately NOT
        // migrated: v1.2 replaces declared counts with the solver's
        // cross-gear plan. Old counts are dropped here.
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
      [['dontcare', "Don't care"], ['closest', 'Closest'], ['atleast', 'At least'], ['maximize', 'Maximize']].forEach(function (pair) {
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
      var tdPrio = el('td');
      var prio = document.createElement('input');
      prio.type = 'number'; prio.min = '1'; prio.step = '1';
      prio.className = 'prio-input';
      prio.id = prefix + '-prio-' + s.key;
      prio.title = 'Maximize priority (1 = fill this stat first; blank = row order)';
      tdPrio.appendChild(prio);
      tr.appendChild(tdPrio);
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
      lab.appendChild(el('span', null, r.label + (r.key === 'legacyHelmets' ? ' (default off)' : '') + (r.key === 'helminth' ? ' (default off)' : '') + (r.key === 'augments' ? ' (default off)' : '')));
      container.appendChild(lab);
    });
  }
  function buildControls() {
    buildTargetRows($('targets-frame-table').querySelector('tbody'), FRAME_STATS, 'ftgt');
    buildTargetRows($('targets-weapon-table').querySelector('tbody'), WEAPON_STATS, 'wtgt');
    buildTargetRows($('targets-damage-table').querySelector('tbody'), DMG_STATS, 'dtgt');
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
      var mode = $(prefix + '-mode-' + k), val = $(prefix + '-val-' + k),
          prio = $(prefix + '-prio-' + k);
      if (!mode || !val) return;
      mode.value = store[k].mode;
      val.value = store[k].value;
      // A target value only matters for Closest / At least; Maximize
      // uses the priority column instead.
      val.disabled = store[k].mode === 'dontcare' || store[k].mode === 'maximize';
      if (prio) {
        prio.value = store[k].priority == null ? '' : store[k].priority;
        prio.disabled = store[k].mode !== 'maximize';
      }
    });
  }
  function readTargetsFromUI(store, prefix) {
    Object.keys(store).forEach(function (k) {
      var mode = $(prefix + '-mode-' + k), val = $(prefix + '-val-' + k),
          prio = $(prefix + '-prio-' + k);
      if (!mode || !val) return;
      store[k].mode = mode.value;
      store[k].value = val.value;
      if (prio) store[k].priority = prio.value;
      val.disabled = store[k].mode === 'dontcare' || store[k].mode === 'maximize';
      if (prio) prio.disabled = store[k].mode !== 'maximize';
    });
  }
  // v1.3: the two intent selects (frame panel / weapon panel) mirror
  // the single state.intent; each is enabled only while its panel's
  // Conditional buffs toggle is on, muted otherwise.
  // v1.4: the burst-allowance selects mirror state.hybridAllowance
  // the same way, and enable only for Hybrid under a live
  // Conditional toggle.
  function syncIntentControls() {
    var f = $('sel-intent'), w = $('sel-intent-w');
    if (f) { f.value = state.intent; f.disabled = !state.routesFrame.conditional; }
    if (w) { w.value = state.intent; w.disabled = !state.routesWeapon.conditional; }
    var hybrid = state.intent === 'hybrid';
    var fa = $('sel-allowance'), wa = $('sel-allowance-w');
    if (fa) { fa.value = String(state.hybridAllowance); fa.disabled = !state.routesFrame.conditional || !hybrid; }
    if (wa) { wa.value = String(state.hybridAllowance); wa.disabled = !state.routesWeapon.conditional || !hybrid; }
    var bf = $('intent-block');
    if (bf) bf.classList.toggle('intent-off', !state.routesFrame.conditional);
    var bw = $('intent-block-w');
    if (bw) bw.classList.toggle('intent-off', !state.routesWeapon.conditional);
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
    applyTargetsToUI(state.dmgTargets, 'dtgt');
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
    if (cat.id === 'Warframe') return 'Ash';
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
    readTargetsFromUI(state.dmgTargets, 'dtgt');
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
    // v1.3: intent is read from the select of the panel the user is
    // looking at (the frame panel serves frame/necramech/companion).
    // v1.4: 'hybrid' is a legal value, and the panel's allowance
    // select is read alongside it.
    var intentSel = isFrameKind(cat.kind) ? $('sel-intent')
      : isWeaponKind(cat.kind) ? $('sel-intent-w') : null;
    if (intentSel && (intentSel.value === 'window' || intentSel.value === 'upkeep' || intentSel.value === 'hybrid')) {
      state.intent = intentSel.value;
    }
    var allowSel = isFrameKind(cat.kind) ? $('sel-allowance')
      : isWeaponKind(cat.kind) ? $('sel-allowance-w') : null;
    if (allowSel) {
      var av = parseInt(allowSel.value, 10);
      if (av === 1 || av === 2) state.hybridAllowance = av;
    }
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
    // v1.2 cross-gear toggle (the include/exclude lists are edited
    // through their own buttons and saved at edit time).
    var cgCb = $('chk-crossgear');
    if (cgCb) state.crossGear.on = cgCb.checked;
    // v1.2 Helminth forced choice controls (built for the frame
    // category; values are read whenever the controls exist).
    var hmChoose = $('helm-mode-choose');
    if (hmChoose) state.helminthMode = hmChoose.checked ? 'choose' : 'auto';
    var hDonor = $('sel-helm-donor');
    if (hDonor && hDonor.options.length) state.helminthChoice.donor = hDonor.value || '';
    var hRep = $('sel-helm-replace');
    if (hRep && hRep.options.length) {
      var hri2 = parseInt(hRep.value, 10);
      if (Number.isInteger(hri2)) state.helminthChoice.replacesIndex = hri2;
    }
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
    $('targets-damage-wrap').hidden = !isWeaponKind(cat.kind);
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
    refreshLocksUI();
    renderCrossGearPanel();
    syncIntentControls();
    var framePanel = isFrameKind(cat.kind);
    $('routes-frame-panel').hidden = !framePanel;
    $('routes-weapon-panel').hidden = !isWeaponKind(cat.kind);
    $('routes-amp-panel').hidden = cat.kind !== 'amp';
    $('routes-companion-panel').hidden = cat.kind !== 'companion';
    // The cross-gear plan exists for Warframes and weapons (the two
    // solvers' set accounting); Necramech/companion routes are the
    // subset kinds, and Amps have no set plan at all.
    $('sets-panel').hidden = !(cat.kind === 'frame' || isWeaponKind(cat.kind));
    $('wallet-panel').hidden = cat.kind !== 'frame';
    $('forma-panel').hidden = cat.kind === 'amp';
    if (framePanel) {
      ROUTES_FRAME.forEach(function (r) {
        var wrap = $('route-wrap-' + r.key);
        if (!wrap) return;
        var show = cat.kind === 'frame' || SUBSET_KIND_ROUTES.indexOf(r.key) >= 0;
        wrap.style.display = show ? '' : 'none';
      });
      // v1.4: the augments caption explains a Warframe-only toggle
      // (hidden for the subset kinds alongside its checkbox wrap).
      var augCap = $('augments-caption');
      if (augCap) augCap.style.display = cat.kind === 'frame' ? '' : 'none';
      $('helminth-block').hidden = !(cat.kind === 'frame' && state.routesFrame.helminth);
      if (cat.kind === 'frame' && state.routesFrame.helminth) {
        buildLockChecks();
        buildHelminthChooser();
      }
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
    // The board hides itself when it belongs to another category/item.
    if (boardCur) refreshBoardUI();
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

  // ---- mod pool + locks (v1.1) ---------------------------------------------------
  // SITE.modpool (data/modpool.json) is the FULL mod list — the pickers
  // and extraModRecords are built from it because the solver pools
  // (mods.json) omit the ~812 mods with no derived effects, and those
  // are exactly the mods a player locks in by hand.
  function modpoolRec(name) {
    return (SITE.modpoolByName && SITE.modpoolByName[name]) || null;
  }
  // The mod Types legal on the current item — mirrors the solvers' own
  // pool rules (frame kinds by fixed/companion type sets; weapons via
  // WeaponSolver's poolFor over the live bundle, taking the types of
  // the mods it admits plus the weapon's own Name/Family types).
  function pickerTypeSet() {
    var cat = currentCat();
    var set = {};
    if (cat.kind === 'frame') { set.Warframe = 1; return set; }
    if (cat.kind === 'necramech') { set.Necramech = 1; return set; }
    if (cat.kind === 'companion') {
      set.Companion = 1;
      var comp = null, store = null;
      try { comp = currentCompanion(); } catch (e) { comp = null; }
      try { store = companionStoreEntry(); } catch (e) { store = null; }
      var e = (comp && comp.companionEntry) || store;
      if (e) {
        if (e.Type) set[e.Type] = 1;
        if (e.Name) set[e.Name] = 1;
        if (e.Category === 'Sentinels') { set.Sentinel = 1; set.Robotic = 1; }
        if (e.Type === 'MOA') { set.MOA = 1; set.Robotic = 1; }
        if (e.Type === 'Hound') { set.Hound = 1; set.Robotic = 1; }
        if (e.Category === 'Pets') set.Beast = 1;
      }
      return set;
    }
    if (isWeaponKind(cat.kind)) {
      var w = null;
      try { w = currentWeapon(); } catch (e2) { w = null; }
      if (w) {
        try {
          var ctx = window.WeaponSolver._internal.buildContext(evalBundle());
          var pool = window.WeaponSolver._internal.poolFor(ctx, w.entry);
          pool.mods.forEach(function (m) { if (m.type) set[m.type] = 1; });
        } catch (e3) { /* picker stays empty; the solver still validates */ }
        if (w.entry.Name) set[w.entry.Name] = 1;
        if (w.entry.Family) set[w.entry.Family] = 1;
      }
      return set;
    }
    return set;
  }
  // v1.4: the item a restricted record belongs to, in the current
  // picker context (mirrors the engines' exact-name eligibility).
  function pickerItemName() {
    var cat = currentCat();
    if (cat.kind === 'frame') return state.selections.Warframe;
    if (cat.kind === 'necramech') return state.selections.Necramech;
    if (cat.kind === 'companion') {
      var comp = null;
      try { comp = currentCompanion(); } catch (e) { comp = null; }
      return comp ? comp.frameName : state.selections.Companion;
    }
    if (isWeaponKind(cat.kind)) {
      var w = null;
      try { w = currentWeapon(); } catch (e2) { w = null; }
      return w ? (w.entry && w.entry.Name) || w.name : null;
    }
    return null;
  }
  // Frame abilities from the solver bundle — the same data the
  // engine's augmentEligible reads (assembleBundle already carries
  // each frame's Abilities).
  function pickerFrameAbilities(frameName) {
    var wf = (BUNDLE && BUNDLE.warframes && BUNDLE.warframes.Warframes) || {};
    var f = wf[frameName];
    return (f && f.Abilities) || [];
  }
  // May this restricted record be offered in the current picker?
  // Ability augments surface ONLY with the Augments route ON and
  // only where the engine's shared rule admits them for the current
  // frame + current Helminth choice (the choice confers eligibility
  // only in choose-mode with the route on — currentHelminthChoice
  // applies exactly that gate, like the engine). Every other
  // restricted record (weapon / companion stat mods) surfaces on its
  // own item only, never gated by the Augments toggle.
  function pickerRestrictedOk(m) {
    if (window.Solver.isAugmentRecord(m)) {
      if (!state.routesFrame.augments) return false;
      if (currentCat().kind !== 'frame') return false;
      var frame = state.selections.Warframe;
      if (!frame) return false;
      var choice = currentHelminthChoice() || null;
      return window.Solver.augmentEligible(m, frame, choice, pickerFrameAbilities(frame));
    }
    return !!m.restrictedTo && m.restrictedTo === pickerItemName();
  }
  // Names offered by the lock / swap-in pickers for the current item.
  // Stance/posture records (negative baseDrain) are slot furniture,
  // never normal-slot mods, so they are not offered. Restricted
  // records (v1.4) are offered only where pickerRestrictedOk admits
  // them — before the pipeline fix they matched no type at all; now
  // their pool type matches broadly, so the restriction itself is
  // the filter.
  function pickerModNames(exilusOnly) {
    var types = pickerTypeSet();
    var names = [];
    ((SITE.modpool && SITE.modpool.mods) || []).forEach(function (m) {
      if (!types[m.type]) return;
      if ((m.baseDrain || 0) < 0) return;
      if (exilusOnly && !m.exilus) return;
      if (m.restrictedTo && !pickerRestrictedOk(m)) return;
      names.push(m.name);
    });
    if (currentCat().kind === 'companion') {
      ((SITE.links && SITE.links.mods) || []).forEach(function (lm) {
        if (names.indexOf(lm.name) < 0) names.push(lm.name);
      });
    }
    return names.sort();
  }
  function arcanePickerNames() {
    var cat = currentCat();
    var out = [];
    var w = null;
    if (isWeaponKind(cat.kind)) {
      try { w = currentWeapon(); } catch (e) { w = null; }
      if (!w) return out;
    }
    (SITE.arcanes.arcanes || []).forEach(function (a) {
      if (w) {
        if (window.WeaponSolver._internal.arcaneTypeMatches(a, w.entry)) out.push(a.name);
      } else if (cat.kind === 'amp') {
        // v1.4.1: an Amp build equips Amp + Operator arcanes (13 + 22);
        // the Warframe set this branch used to fall into fits neither
        // of the amp solver's arcane slots.
        if (a.type === 'Amp' || a.type === 'Operator') out.push(a.name);
      } else if (a.type === 'Warframe') {
        out.push(a.name);
      }
    });
    return out.sort();
  }
  // v1.4.1: the lock-arcane caption — the picker list IS a filtered
  // universe (the arcanes equippable on this category of gear), and
  // until it said so, a correct 64-name Warframe list read as
  // "not a full list" (Tacusin's report).
  function arcaneUniverseCaption() {
    var cat = currentCat();
    if (cat.kind === 'amp') {
      return 'Showing Amp and Operator arcanes — the set equippable on this gear.';
    }
    if (isWeaponKind(cat.kind)) {
      return 'Showing the arcanes equippable on the selected weapon.';
    }
    return 'Showing Warframe arcanes — the set equippable on this gear.';
  }
  // extraModRecords for the solvers/evaluators: full records for mods
  // the stat pools do not carry (stat-less locks and swap-ins). Records
  // for pooled mods are ignored by the solvers' resolution order, so
  // callers may pass every name they care about.
  function extraRecordsFor(names) {
    var out = {};
    (names || []).forEach(function (name) {
      var mp = modpoolRec(name);
      if (!mp) return;
      out[name] = {
        name: mp.name, type: mp.type, polarity: mp.polarity,
        baseDrain: mp.baseDrain || 0, maxRank: mp.maxRank || 0,
        rarity: mp.rarity, exilus: !!mp.exilus, set: mp.set,
        incompatible: mp.incompatible || [],
        // v1.4: the engines' lock normalisers read these — without
        // them a locked augment arrives unrecognisable and its
        // eligibility can never be judged.
        restrictedTo: mp.restrictedTo || null,
        augmentsAbility: mp.augmentsAbility || null,
        effects: []
      };
    });
    return Object.keys(out).length ? out : undefined;
  }
  function locksFor(catId) {
    if (!state.locks[catId]) state.locks[catId] = { mods: [], arcanes: [] };
    return state.locks[catId];
  }
  function isLockedMod(name) {
    return locksFor(state.category).mods.some(function (L) { return L.name === name; });
  }
  // v1.2 excludes (bans): the mirror image of the locks, per category.
  function excludesFor(catId) {
    if (!state.excludes[catId]) state.excludes[catId] = { mods: [], arcanes: [] };
    return state.excludes[catId];
  }
  function isExcludedMod(catId, name) {
    return excludesFor(catId).mods.indexOf(name) >= 0;
  }
  // v1.3: the conditional-class tag for pickers — " · burst 3s",
  // " · maintainable", " · unknown" (window shown when the class row
  // carries one). Unclassified pieces get no tag.
  function classRow(name) {
    return (SITE && SITE.conditionalClasses && SITE.conditionalClasses[name]) || null;
  }
  function classTag(name) {
    var row = classRow(name);
    if (!row) return '';
    return ' · ' + row.class + (row.windowSeconds != null ? ' ' + fmt(row.windowSeconds) + 's' : '');
  }
  // v1.4: the augment badge for picker rows and board cells —
  // "augment · <Ability>" when the augment→ability link resolved,
  // plain "augment" for the unlinked fallback population.
  function augmentBadge(name) {
    var mp = modpoolRec(name);
    if (!mp || !window.Solver.isAugmentRecord(mp)) return '';
    return 'augment' + (mp.augmentsAbility ? ' · ' + mp.augmentsAbility : '');
  }
  function fillDatalist(dl, names) {
    if (!dl) return;
    dl.innerHTML = '';
    names.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n;
      // v1.4.1 (Tacusin's call, superseding the v1.3 picker tags AND
      // the first v1.4.1 fix): dropdown rows are the piece NAME ONLY —
      // no class/augment tags in pickers. v1.3 had set the label to the
      // tag alone, which rendered nameless "· maintainable 9s" rows
      // (his screenshot report); class info lives in the guide and
      // results, not in dropdowns.
      o.textContent = n;
      dl.appendChild(o);
    });
  }
  function refreshLocksUI() {
    var cat = currentCat();
    // The locks panel itself stays hidden for Amps (the amp solver
    // takes no locks — a visible panel would be a dead control), but
    // the datalists are refilled for EVERY category: returning early
    // left the previous category's names sitting in them (the Amp
    // category inherited the Warframe arcane list verbatim).
    $('locks-panel').hidden = cat.kind === 'amp';
    fillDatalist($('lock-mod-list'), pickerModNames(false));
    fillDatalist($('lock-arcane-list'), arcanePickerNames());
    var cap = $('lock-arcane-caption');
    if (cap) cap.textContent = arcaneUniverseCaption();
    renderLockLists();
  }
  function renderLockLists() {
    var lk = locksFor(state.category);
    var ml = $('locked-mods-list');
    ml.innerHTML = '';
    lk.mods.forEach(function (L, i) {
      var mp = modpoolRec(L.name);
      var li = el('li', 'lock-row');
      li.appendChild(el('span', null, '📌 ' + L.name + ' — rank ' + L.rank + '/' + (mp ? mp.maxRank : '?')));
      var dn = el('button', null, '−'); dn.type = 'button';
      dn.addEventListener('click', function () {
        L.rank = Math.max(0, L.rank - 1); renderLockLists(); saveState();
      });
      var up = el('button', null, '+'); up.type = 'button';
      up.addEventListener('click', function () {
        L.rank = Math.min(mp ? mp.maxRank : L.rank, L.rank + 1); renderLockLists(); saveState();
      });
      var rm = el('button', null, 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        lk.mods.splice(i, 1); renderLockLists(); saveState(); refreshBoardUI();
      });
      li.appendChild(dn); li.appendChild(up); li.appendChild(rm);
      ml.appendChild(li);
    });
    if (!lk.mods.length) ml.appendChild(el('li', 'muted', 'No locked mods.'));
    var al = $('locked-arcanes-list');
    al.innerHTML = '';
    lk.arcanes.forEach(function (name, i) {
      var li = el('li', 'lock-row');
      li.appendChild(el('span', null, '📌 ' + name));
      var rm = el('button', null, 'Remove'); rm.type = 'button';
      rm.addEventListener('click', function () {
        lk.arcanes.splice(i, 1); renderLockLists(); saveState();
      });
      li.appendChild(rm);
      al.appendChild(li);
    });
    if (!lk.arcanes.length) al.appendChild(el('li', 'muted', 'No locked arcanes.'));
    renderExcludeLists();
  }
  // The excluded (banned) half of piece control: name lists with a
  // remove ✕ each. Kept beside the lock lists so the two halves of a
  // piece's state are visible at a glance.
  function renderExcludeLists() {
    var ex = excludesFor(state.category);
    var ml = $('excluded-mods-list');
    if (!ml) return;
    ml.innerHTML = '';
    ex.mods.forEach(function (name, i) {
      var li = el('li', 'lock-row excl-row');
      li.appendChild(el('span', null, '🚫 ' + name + ' (excluded)'));
      var rm = el('button', null, '✕'); rm.type = 'button';
      rm.title = 'Remove exclusion';
      rm.addEventListener('click', function () {
        ex.mods.splice(i, 1); renderLockLists(); saveState(); refreshBoardUI();
      });
      li.appendChild(rm);
      ml.appendChild(li);
    });
    var al = $('excluded-arcanes-list');
    al.innerHTML = '';
    ex.arcanes.forEach(function (name, i) {
      var li = el('li', 'lock-row excl-row');
      li.appendChild(el('span', null, '🚫 ' + name + ' (excluded)'));
      var rm = el('button', null, '✕'); rm.type = 'button';
      rm.title = 'Remove exclusion';
      rm.addEventListener('click', function () {
        ex.arcanes.splice(i, 1); renderLockLists(); saveState();
      });
      li.appendChild(rm);
      al.appendChild(li);
    });
  }
  function addLockFromSearch(kind) {
    var cat = currentCat();
    var lk = locksFor(cat.id);
    var ex = excludesFor(cat.id);
    if (kind === 'mod') {
      var name = $('lock-mod-search').value.trim();
      if (pickerModNames(false).indexOf(name) < 0) {
        $('calc-status').textContent = '"' + name + '" is not a lockable mod for this category.';
        return;
      }
      if (lk.mods.some(function (L) { return L.name === name; })) {
        $('calc-status').textContent = name + ' is already locked.';
        return;
      }
      if (ex.mods.indexOf(name) >= 0) {
        $('calc-status').textContent = name + ' is excluded — remove the exclusion before locking it.';
        return;
      }
      var mp = modpoolRec(name);
      lk.mods.push({ name: name, rank: mp ? mp.maxRank : 0 });
      $('lock-mod-search').value = '';
    } else {
      var an = $('lock-arcane-search').value.trim();
      if (arcanePickerNames().indexOf(an) < 0) {
        $('calc-status').textContent = '"' + an + '" is not a lockable arcane for this category.';
        return;
      }
      if (lk.arcanes.indexOf(an) >= 0) {
        $('calc-status').textContent = an + ' is already locked.';
        return;
      }
      if (ex.arcanes.indexOf(an) >= 0) {
        $('calc-status').textContent = an + ' is excluded — remove the exclusion before locking it.';
        return;
      }
      lk.arcanes.push(an);
      $('lock-arcane-search').value = '';
    }
    $('calc-status').textContent = '';
    renderLockLists();
    saveState();
  }
  // The Exclude buttons beside the Lock buttons: same searches, the
  // ban half of piece control. A locked piece cannot be banned (the
  // engine treats lock∩ban as a hard error; the UI refuses first).
  function addExcludeFromSearch(kind) {
    var cat = currentCat();
    var lk = locksFor(cat.id);
    var ex = excludesFor(cat.id);
    if (kind === 'mod') {
      var name = $('lock-mod-search').value.trim();
      if (pickerModNames(false).indexOf(name) < 0) {
        $('calc-status').textContent = '"' + name + '" is not an excludable mod for this category.';
        return;
      }
      if (lk.mods.some(function (L) { return L.name === name; })) {
        $('calc-status').textContent = name + ' is locked — remove the lock before excluding it.';
        return;
      }
      if (ex.mods.indexOf(name) >= 0) {
        $('calc-status').textContent = name + ' is already excluded.';
        return;
      }
      ex.mods.push(name);
      $('lock-mod-search').value = '';
    } else {
      var an = $('lock-arcane-search').value.trim();
      if (arcanePickerNames().indexOf(an) < 0) {
        $('calc-status').textContent = '"' + an + '" is not an excludable arcane for this category.';
        return;
      }
      if (lk.arcanes.indexOf(an) >= 0) {
        $('calc-status').textContent = an + ' is locked — remove the lock before excluding it.';
        return;
      }
      if (ex.arcanes.indexOf(an) >= 0) {
        $('calc-status').textContent = an + ' is already excluded.';
        return;
      }
      ex.arcanes.push(an);
      $('lock-arcane-search').value = '';
    }
    $('calc-status').textContent = '';
    renderLockLists();
    saveState();
    refreshBoardUI();
  }
  // Attach the category's locks (if any) to a solve input.
  function applyLocksToInput(input) {
    var lk = locksFor(state.category);
    if (lk.mods.length) {
      input.lockedMods = lk.mods.map(function (L) { return { name: L.name, rank: L.rank }; });
      var ex = extraRecordsFor(lk.mods.map(function (L) { return L.name; }));
      if (ex) input.extraModRecords = ex;
    }
    if (lk.arcanes.length) input.lockedArcanes = lk.arcanes.slice();
  }
  // Attach the category's excludes (if any) to a solve input.
  function applyExcludesToInput(input) {
    var ex = excludesFor(state.category);
    if (ex.mods.length) input.excludedMods = ex.mods.slice();
    if (ex.arcanes.length) input.excludedArcanes = ex.arcanes.slice();
  }

  // ---- Helminth forced choice (v1.2) ------------------------------------------
  // Donor options for the current frame: every subsumable ability
  // (deduped by name), labelled "<Ability> (<Donor Frame>)", minus
  // the frame's own family — mirroring the engine's rule (a frame
  // cannot subsume its own ability; Prime counts as the same family).
  function helminthDonorOptions(frameName) {
    var base = String(frameName || '').replace(/ Prime$/, '');
    var seen = {}, out = [];
    ((SITE.helminth && SITE.helminth.subsumes) || []).forEach(function (s) {
      if (seen[s.ability]) return;
      seen[s.ability] = 1;
      if (String(s.frame).replace(/ Prime$/, '') === base) return;
      out.push({ ability: s.ability, frame: s.frame, modelled: !!s.effects });
    });
    out.sort(function (a, b) { return a.ability < b.ability ? -1 : 1; });
    return out;
  }
  function buildHelminthChooser() {
    var donorSel = $('sel-helm-donor'), repSel = $('sel-helm-replace');
    if (!donorSel || !repSel) return;
    var frame = state.selections.Warframe;
    $('helm-mode-auto').checked = state.helminthMode !== 'choose';
    $('helm-mode-choose').checked = state.helminthMode === 'choose';
    $('helminth-choose').hidden = state.helminthMode !== 'choose';
    // Donor select
    var opts = helminthDonorOptions(frame);
    donorSel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = ''; ph.textContent = '— pick a donor ability —';
    donorSel.appendChild(ph);
    opts.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.ability;
      op.textContent = o.ability + ' (' + o.frame + ')' + (o.modelled ? '' : ' — not stat-modelled');
      donorSel.appendChild(op);
    });
    var donorOk = opts.some(function (o) { return o.ability === state.helminthChoice.donor; });
    donorSel.value = donorOk ? state.helminthChoice.donor : '';
    // Replace select: the frame's four abilities; locked ones are
    // disabled (a locked ability can never be replaced).
    var abilities = (SITE.frames.warframes[frame] || {}).abilities || [];
    var locks = state.abilityLocks[frame] || [];
    repSel.innerHTML = '';
    abilities.forEach(function (a, i) {
      var op = document.createElement('option');
      op.value = String(i);
      op.textContent = a + (locks[i] ? ' (locked)' : '');
      op.disabled = !!locks[i];
      repSel.appendChild(op);
    });
    var ri = state.helminthChoice.replacesIndex;
    if (!(ri >= 0 && ri < abilities.length) || locks[ri]) {
      ri = 0;
      while (ri < abilities.length && locks[ri]) ri++;
    }
    repSel.value = abilities.length ? String(Math.min(ri, abilities.length - 1)) : '';
    var note = '';
    if (state.helminthMode === 'choose') {
      var donor = opts.filter(function (o) { return o.ability === donorSel.value; })[0];
      if (donor && !donor.modelled) {
        note = donor.ability + ' is not stat-modelled: it will ride as a build instruction with its diminished text and will not change the solved stats.';
      }
      if (abilities.length && locks[state.helminthChoice.replacesIndex]) {
        note = (note ? note + ' ' : '') + 'The ability you picked to replace is locked — unlock it or pick another.';
      }
    }
    $('helm-note').textContent = note;
  }
  // The forced choice to pass on a solve, or undefined: only in
  // "I'll choose" mode with the route on and a donor that is legal
  // for the CURRENT frame (a stale own-family pick is dropped, not
  // sent to the engine to throw on).
  function currentHelminthChoice() {
    if (state.helminthMode !== 'choose' || !state.routesFrame.helminth) return undefined;
    var donor = state.helminthChoice.donor;
    if (!donor) return undefined;
    var legal = helminthDonorOptions(state.selections.Warframe)
      .some(function (o) { return o.ability === donor; });
    if (!legal) return undefined;
    return { donor: donor, replacesIndex: state.helminthChoice.replacesIndex | 0 };
  }

  // ---- cross-gear planning UI (v1.2) -------------------------------------------
  // Gear label for a support mod from its pool Type — mirrors the
  // engine's gearLabelForType (solver.js / weaponSolver.js) so the
  // include list shows the same gear the plan will name.
  function gearLabelForType(type) {
    if (!type) return 'Support gear';
    if (type === 'Warframe') return 'Warframe';
    if (type === 'Aura') return 'Warframe (Aura slot)';
    if (type === 'Necramech') return 'Necramech';
    if (type === 'Archgun') return 'Archgun';
    if (type === 'Archmelee') return 'Archmelee';
    if (['Rifle', 'Shotgun', 'Sniper', 'Bow', 'Primary',
         'Assault Rifle'].indexOf(type) >= 0) return 'Primary';
    if (type === 'Pistol' || type === 'Tome') return 'Secondary';
    if (['Companion', 'Beast', 'Claws', 'Robotic', 'Robotic Weapon',
         'Sentinel', 'Kavat Claws', 'Kubrow Claws'].indexOf(type) >= 0 ||
        /Kavat|Kubrow|Vulpaphyla|Predasite|Charger/.test(type) ||
        type === 'MOA' || type === 'Hound') return 'Companion';
    return 'Melee';
  }
  // Mods that can be cross-gear for the current item: in the full
  // pool but NOT in the focus category's own pool (those belong to
  // the focus solve). Stance/posture furniture (negative drain) is
  // never offered, same as the lock/swap pickers.
  function crossGearCandidateNames() {
    var types = pickerTypeSet();
    var names = [];
    ((SITE.modpool && SITE.modpool.mods) || []).forEach(function (m) {
      if (types[m.type]) return;
      if ((m.baseDrain || 0) < 0) return;
      names.push(m.name);
    });
    return names.sort();
  }
  function renderCrossGearPanel() {
    if (!$('chk-crossgear')) return;
    var cg = state.crossGear;
    $('chk-crossgear').checked = !!cg.on;
    var names = crossGearCandidateNames();
    fillDatalist($('cg-include-list'), names);
    var exNames = Object.keys(SITE.setBonuses.sets).sort().concat(names);
    fillDatalist($('cg-exclude-list'), exNames);
    var ul = $('cg-includes');
    ul.innerHTML = '';
    cg.include.forEach(function (e, i) {
      var mp = modpoolRec(e.mod);
      var li = el('li', 'lock-row');
      li.appendChild(el('span', null, '➕ ' + e.mod + ' → ' + gearLabelForType(mp ? mp.type : null)));
      var rm = el('button', null, '✕'); rm.type = 'button';
      rm.title = 'Remove include';
      rm.addEventListener('click', function () {
        cg.include.splice(i, 1); renderCrossGearPanel(); saveState();
      });
      li.appendChild(rm);
      ul.appendChild(li);
    });
    if (!cg.include.length) ul.appendChild(el('li', 'muted', 'No forced cross-gear includes.'));
    var xl = $('cg-excludes');
    xl.innerHTML = '';
    cg.exclude.forEach(function (name, i) {
      var li = el('li', 'lock-row excl-row');
      li.appendChild(el('span', null, '🚫 ' + name + ' (excluded from the plan)'));
      var rm = el('button', null, '✕'); rm.type = 'button';
      rm.title = 'Remove exclusion';
      rm.addEventListener('click', function () {
        cg.exclude.splice(i, 1); renderCrossGearPanel(); saveState();
      });
      li.appendChild(rm);
      xl.appendChild(li);
    });
    if (!cg.exclude.length) xl.appendChild(el('li', 'muted', 'No cross-gear exclusions.'));
  }
  function addCrossGearInclude() {
    var name = $('cg-include-search').value.trim();
    if (crossGearCandidateNames().indexOf(name) < 0) {
      $('calc-status').textContent = '"' + name + '" is not a cross-gear mod for this category (it must live on other gear).';
      return;
    }
    if (state.crossGear.include.some(function (e) { return e.mod === name; })) {
      $('calc-status').textContent = name + ' is already force-included.';
      return;
    }
    state.crossGear.include.push({ mod: name });
    $('cg-include-search').value = '';
    $('calc-status').textContent = '';
    renderCrossGearPanel();
    saveState();
  }
  function addCrossGearExclude() {
    var name = $('cg-exclude-search').value.trim();
    var isSet = !!SITE.setBonuses.sets[name];
    if (!isSet && crossGearCandidateNames().indexOf(name) < 0) {
      $('calc-status').textContent = '"' + name + '" is neither a set name nor a cross-gear mod for this category.';
      return;
    }
    if (state.crossGear.exclude.indexOf(name) >= 0) {
      $('calc-status').textContent = name + ' is already excluded from the plan.';
      return;
    }
    state.crossGear.exclude.push(name);
    $('cg-exclude-search').value = '';
    $('calc-status').textContent = '';
    renderCrossGearPanel();
    saveState();
  }
  // The crossGear input for a solve: presence IS the engine's route
  // gate, so it is sent (possibly empty) exactly when the toggle is on.
  function crossGearInput() {
    if (!state.crossGear.on) return undefined;
    var out = {};
    if (state.crossGear.include.length) {
      out.include = state.crossGear.include.map(function (e) { return { mod: e.mod }; });
    }
    if (state.crossGear.exclude.length) out.exclude = state.crossGear.exclude.slice();
    return out;
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
      if (t.mode === 'maximize') {
        // Maximize needs no value; an explicit priority wins, a blank
        // one leaves the solver's default (row order).
        var entry = { mode: 'maximize' };
        var pr = parseInt(t.priority, 10);
        if (Number.isInteger(pr) && pr >= 1) entry.priority = pr;
        if (s.lowerBetter) entry.lowerBetter = true;
        targets[s.key] = entry;
        return;
      }
      var v = parseFloat(t.value);
      if (isNaN(v)) return;
      var entry2 = { mode: t.mode, value: v };
      if (s.lowerBetter) entry2.lowerBetter = true;
      targets[s.key] = entry2;
    });
    return targets;
  }
  function weaponTargetStore() {
    return Object.assign({}, state.weaponTargets, state.dmgTargets);
  }
  // The bundle for the current selection — Kitguns/Zaws solve against
  // an override weapons map holding the assembled entry.
  function evalBundle() {
    var cat = currentCat();
    if (cat.kind === 'kitgun' || cat.kind === 'zaw') {
      var w = null;
      try { w = currentWeapon(); } catch (e) { w = null; }
      if (w && w.assembled) {
        var weapons = Object.assign({}, SITE.weapons);
        weapons[w.name] = w.entry;
        return Object.assign({}, BUNDLE, { weapons: weapons });
      }
    }
    return BUNDLE;
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
  function buildSolveRequest() {
    var cat = currentCat();
    if (cat.kind === 'frame') {
      var frame = state.selections.Warframe;
      if (!frame || !SITE.frames.warframes[frame]) throw new Error('Pick a valid frame first (Item tab).');
      var routes = {};
      ROUTES_FRAME.forEach(function (r) { routes[r.key] = !!state.routesFrame[r.key]; });
      var finput = {
        frameName: frame,
        targets: collectTargets(state.frameTargets, FRAME_STATS),
        routes: routes,
        abilityLocks: state.abilityLocks[frame] || [],
        shardWallet: shardWalletInput(),
        formaBudget: state.forma,
        umbraForma: state.umbraForma,
        reactor: true,
        intent: state.intent,
        hybridAllowance: state.hybridAllowance
      };
      var hc = currentHelminthChoice();
      if (hc) finput.helminthChoice = hc;
      var fcg = crossGearInput();
      if (fcg) finput.crossGear = fcg;
      applyLocksToInput(finput);
      applyExcludesToInput(finput);
      return { kind: 'frame', input: finput, bundle: BUNDLE };
    }
    if (cat.kind === 'necramech') {
      var mech = state.selections.Necramech;
      if (!mech || !SITE.frames.necramechs[mech]) throw new Error('Pick a valid Necramech first (Item tab).');
      var minput = {
        itemKind: 'necramech',
        frameName: mech,
        targets: collectTargets(state.frameTargets, FRAME_STATS),
        routes: { mods: state.routesFrame.mods, conditional: state.routesFrame.conditional },
        formaBudget: state.forma,
        umbraForma: state.umbraForma,
        intent: state.intent,
        hybridAllowance: state.hybridAllowance
      };
      applyLocksToInput(minput);
      applyExcludesToInput(minput);
      return { kind: 'frame', input: minput, bundle: BUNDLE };
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
        umbraForma: state.umbraForma,
        intent: state.intent,
        hybridAllowance: state.hybridAllowance
      };
      if (comp.companionEntry) cinput.companionEntry = comp.companionEntry;
      if (owner) cinput.ownerStats = owner;
      applyLocksToInput(cinput);
      applyExcludesToInput(cinput);
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
        targets: Object.assign(collectTargets(state.weaponTargets, WEAPON_STATS),
          collectTargets(state.dmgTargets, DMG_STATS)),
        routes: wroutes,
        formaBudget: state.forma,
        umbraForma: state.umbraForma,
        intent: state.intent,
        hybridAllowance: state.hybridAllowance
      };
      if (w.entry.IsLichWeapon) {
        var pct = Math.min(60, Math.max(25, state.progenitor.percent || 60));
        winput.progenitor = { element: state.progenitor.element, percent: pct };
      }
      var wcg = crossGearInput();
      if (wcg) winput.crossGear = wcg;
      applyLocksToInput(winput);
      applyExcludesToInput(winput);
      return { kind: 'weapon', input: winput, bundle: evalBundle() };
    }
    if (cat.kind === 'amp') {
      var amp = currentAmp();
      var targets = {};
      AMP_STATS.forEach(function (s) {
        var t = state.ampTargets[s.key];
        // The amp solver has no fill phase — Maximize is not offered
        // to it (the exhaustive arcane search already maximises the
        // targeted stats it can).
        if (!t || t.mode === 'dontcare' || t.mode === 'maximize') return;
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
      var parts = [sb.focusPieces + ' on this item'];
      if (sb.supportPieces) parts.push(sb.supportPieces + ' support');
      if (sb.plannedPieces) parts.push(sb.plannedPieces + ' planned cross-gear');
      var line = sb.set + ' — ' + sb.pieces + ' piece' + (sb.pieces === 1 ? '' : 's') +
        ' (' + parts.join(' + ') + ')';
      if (sb.perPiece && sb.perPiece.length === 1 && typeof sb.perPiece[0].value === 'number') {
        line += ': ' + fmt(sb.perPiece[0].value) + (sb.perPiece[0].unit === 'percent' ? '%' : '') +
          ' per piece' + (sb.totalValue != null ? ' → ' + fmt(sb.totalValue) + ' total' : '');
      }
      if (sb.applied) line += ' — applied';
      else if (sb.parseStatus && sb.parseStatus !== 'parsed') line += ' — not modelled (prose effect)';
      return line;
    });
  }
  // v1.2: which stats' breakdown chains are currently expanded.
  // Kept across re-renders so a board edit refreshes the open chain
  // in place instead of collapsing it.
  var expandedBd = {};
  function achievedTable(stats, store, achieved, unmetTargets, fracStats, breakdown) {
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
      if (t && t.mode === 'maximize') {
        targetText = 'Maximize' + (t.priority !== '' && t.priority != null ? ' (priority ' + t.priority + ')' : '');
      }
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
      // v1.2 breakdown toggle (last column): only when the current
      // evaluation carries a contributor chain for this stat.
      var chain = breakdown ? breakdown[s.key] : null;
      var tdT = el('td');
      var bdRow = null, bdBtn = null;
      if (chain && chain.length) {
        bdBtn = el('button', 'bd-toggle', expandedBd[s.key] ? '▾' : '▸');
        bdBtn.type = 'button';
        bdBtn.title = 'What is influencing ' + s.label;
        bdBtn.setAttribute('aria-expanded', expandedBd[s.key] ? 'true' : 'false');
        tdT.appendChild(bdBtn);
      }
      tr.appendChild(tdT);
      tb.appendChild(tr);
      if (chain && chain.length) {
        bdRow = el('tr', 'bd-row');
        bdRow.hidden = !expandedBd[s.key];
        var tdB = el('td');
        tdB.colSpan = 5;
        chain.forEach(function (entry) {
          var line = el('div', 'bd-line');
          line.appendChild(el('span', 'bd-kind', entry.kind || ''));
          // v1.2.1: non-Base lines show the entry's own increase
          // before the running total ("+60 → 305"); Base shows just
          // its value (it IS the starting point).
          var d = (typeof entry.delta === 'number') ? entry.delta : 0;
          var seg = entry.kind === 'base'
            ? entry.source + ' — ' + fmt(entry.cumulative)
            : entry.source + ' — ' + (d < 0 ? '-' : '+') + fmt(Math.abs(d)) +
              ' → ' + fmt(entry.cumulative);
          line.appendChild(el('span', null, seg));
          tdB.appendChild(line);
        });
        bdRow.appendChild(tdB);
        tb.appendChild(bdRow);
        (function (btn, row, key) {
          btn.addEventListener('click', function () {
            expandedBd[key] = !expandedBd[key];
            row.hidden = !expandedBd[key];
            btn.textContent = expandedBd[key] ? '▾' : '▸';
            btn.setAttribute('aria-expanded', expandedBd[key] ? 'true' : 'false');
          });
        })(bdBtn, bdRow, s.key);
      }
    });
  }
  // ---- build board + editor (v1.1) --------------------------------------------
  // boardSolved is the immutable solver output (slots with fit meta +
  // extras + achieved); boardCur is the editable copy the board shows.
  // Every edit re-scores boardCur through the matching evaluate*
  // function — the same forward math as the solvers, no second model.
  var lastInput = null;
  var boardKind = null;      // 'frame' | 'weapon'
  var boardCatId = null;     // category the board belongs to
  var boardItemName = null;  // frameName / weaponName for the evaluators
  var boardSolved = null;
  var boardCur = null;
  var boardSel = -1;
  var boardDragIdx = -1;
  var swapPoolNames = [];

  function cloneSlots(slots) {
    return (slots || []).map(function (s) {
      return {
        kind: s.kind, mod: s.mod, rank: s.rank,
        slotPolarity: s.slotPolarity, innatePolarity: s.innatePolarity,
        formaApplied: !!s.formaApplied, umbraFormaApplied: !!s.umbraFormaApplied,
        effectiveDrain: s.effectiveDrain, origin: s.origin || 'target'
      };
    });
  }
  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  function boardExtrasFromSolve(kind, res) {
    var arr = res.arrangement || {};
    if (kind === 'frame') {
      return {
        arcanes: (arr.arcanes || []).slice(),
        shards: (arr.shards || []).map(function (s) {
          return { colour: s.colour, tier: s.tier, stat: s.stat };
        }),
        tome: arr.tome || null, helmet: arr.helmet || null,
        subsume: arr.subsume || null,
        conditional: !!(lastInput && lastInput.routes && lastInput.routes.conditional),
        formaBudget: lastInput ? lastInput.formaBudget : 'any',
        umbraForma: (lastInput && lastInput.umbraForma) || 0,
        itemKind: lastInput && lastInput.itemKind,
        companionEntry: (lastInput && lastInput.companionEntry) || null,
        ownerStats: (lastInput && lastInput.ownerStats) || null,
        supportSetPieces: (lastInput && lastInput.supportSetPieces) || null
      };
    }
    return {
      arcane: arr.arcane || null,
      conditional: !!(lastInput && lastInput.routes && lastInput.routes.conditional),
      formaBudget: lastInput ? lastInput.formaBudget : 'any',
      umbraForma: (lastInput && lastInput.umbraForma) || 0,
      stance: !(lastInput && lastInput.routes && lastInput.routes.stance === false),
      progenitor: (lastInput && lastInput.progenitor) || null,
      attackIndex: (lastInput && lastInput.attackIndex) || 0,
      weaponName: lastInput && lastInput.weaponName
    };
  }

  function setupBoard(kind, res) {
    boardKind = kind;
    boardCatId = state.category;
    boardItemName = lastInput ? (kind === 'frame' ? lastInput.frameName : lastInput.weaponName) : null;
    boardSolved = {
      slots: cloneSlots(res.arrangement.slots),
      extras: boardExtrasFromSolve(kind, res),
      achieved: res.achieved,
      unmetTargets: res.unmetTargets || []
    };
    boardCur = { slots: cloneSlots(boardSolved.slots), extras: deepClone(boardSolved.extras) };
    boardSel = -1;
    syncBoardState();
    refreshBoardUI();
  }

  function serializeBoard() {
    if (!boardCur) return null;
    return {
      kind: boardKind,
      catId: boardCatId,
      itemKey: currentItemKey(),
      slots: boardCur.slots.map(function (s) {
        return { kind: s.kind, mod: s.mod, rank: s.rank };
      }),
      extras: boardCur.extras
    };
  }
  function syncBoardState() {
    state.board = serializeBoard();
    saveState();
  }

  function evalBoard() {
    var names = boardCur.slots.map(function (s) { return s.mod; }).filter(Boolean);
    var ex = extraRecordsFor(names);
    var slots = boardCur.slots.map(function (s) {
      return { kind: s.kind, mod: s.mod, rank: s.rank };
    });
    if (boardKind === 'frame') {
      var e = boardCur.extras;
      return window.Solver.evaluateFrame(evalBundle(), boardItemName, {
        slots: slots,
        arcanes: e.arcanes || [], shards: e.shards || [],
        tome: e.tome, helmet: e.helmet, subsume: e.subsume,
        conditional: e.conditional,
        formaBudget: e.formaBudget, umbraForma: e.umbraForma || 0,
        reactor: true, itemKind: e.itemKind,
        companionEntry: e.companionEntry, ownerStats: e.ownerStats,
        supportSetPieces: e.supportSetPieces,
        extraModRecords: ex
      });
    }
    var we = boardCur.extras;
    return window.WeaponSolver.evaluateWeapon(evalBundle(), we.weaponName,
      we.attackIndex || 0, {
        slots: slots, arcane: we.arcane,
        conditional: we.conditional,
        formaBudget: we.formaBudget, umbraForma: we.umbraForma || 0,
        stance: we.stance !== false,
        extraModRecords: ex
      }, we.progenitor || null);
  }

  function boardStatDefs() {
    if (boardKind === 'weapon') {
      return { defs: WEAPON_STATS.concat(DMG_STATS), store: weaponTargetStore() };
    }
    var cat = catOf(boardCatId || state.category);
    return {
      defs: cat.kind === 'companion' ? COMPANION_STATS : FRAME_STATS,
      store: state.frameTargets
    };
  }
  // At-least floors broken by a given achieved set — computed from the
  // target store (the solvers' unmetTargets describe the SOLVED build;
  // an edited board needs its own check).
  function computeUnmet(defs, store, achieved) {
    var unmet = [];
    defs.forEach(function (s) {
      var t = store[s.key];
      if (!t || t.mode !== 'atleast') return;
      var v = parseFloat(t.value);
      if (isNaN(v)) return;
      var a = achieved ? achieved[s.key] : null;
      if (typeof a !== 'number') return;
      if (s.lowerBetter ? a > v + 1e-9 : a < v - 1e-9) {
        unmet.push({ stat: s.key, target: v, achieved: a });
      }
    });
    return unmet;
  }

  function slotMaxRank(name, kind) {
    if (!name) return null;
    var rec = modRecord(name) || modpoolRec(name);
    if (rec) return rec.maxRank;
    var lm = ((SITE.links && SITE.links.mods) || []).filter(function (m) { return m.name === name; })[0];
    return lm ? lm.maxRank : null;
  }
  function slotDrainInfo(s) {
    if (!s.mod) return null;
    if (s.kind === 'aura' || s.kind === 'stance') {
      return { eff: s.effectiveDrain || 0, granted: true, matched: false };
    }
    var rec = modRecord(s.mod) || modpoolRec(s.mod);
    if (!rec) return typeof s.effectiveDrain === 'number'
      ? { eff: s.effectiveDrain, granted: false, matched: false } : null;
    var base = (rec.baseDrain || 0) + (s.rank || 0);
    var matched = !!(s.slotPolarity && rec.polarity &&
      (s.slotPolarity === rec.polarity || s.slotPolarity === 'Universal'));
    return {
      eff: matched ? Math.ceil(base / 2) : base,
      granted: false, matched: matched
    };
  }
  function slotKindLabel(s, normalIdx) {
    if (s.kind === 'aura') return 'Aura';
    if (s.kind === 'stance') return 'Stance';
    if (s.kind === 'exilus') return 'Exilus';
    return 'Slot ' + normalIdx;
  }
  function isLockedName(name) {
    return !!name && locksFor(boardCatId || state.category).mods
      .some(function (L) { return L.name === name; });
  }

  function renderBoardGrid() {
    var box = $('board');
    box.innerHTML = '';
    var normalIdx = 0;
    boardCur.slots.forEach(function (s, i) {
      if (s.kind === 'normal') normalIdx++;
      var cell = el('div', 'slot' + (s.mod ? '' : ' empty') +
        (i === boardSel ? ' selected' : '') + (s.kind === 'stance' ? ' fixed' : ''));
      cell.appendChild(el('span', 'slot-kind', slotKindLabel(s, normalIdx)));
      cell.appendChild(el('span', 'slot-mod', s.mod || '— empty —'));
      if (s.mod) {
        var maxR = slotMaxRank(s.mod, s.kind);
        var metaBits = ['r' + s.rank + '/' + (maxR == null ? '?' : maxR)];
        if (s.slotPolarity) metaBits.push(s.slotPolarity);
        cell.appendChild(el('span', 'slot-meta', metaBits.join(' · ')));
        var d = slotDrainInfo(s);
        if (d) {
          var dt = el('span', 'slot-meta' + (d.matched ? ' matched-drain' : ''),
            d.granted ? 'grants ' + Math.abs(d.eff) + ' capacity'
                      : 'drain ' + d.eff + (d.matched ? ' (polarity match)' : ''));
          cell.appendChild(dt);
        }
        if (s.umbraFormaApplied) cell.appendChild(el('span', 'badge', 'Umbra Forma'));
        else if (s.formaApplied) cell.appendChild(el('span', 'badge', 'Forma'));
        if (s.origin === 'fill') cell.appendChild(el('span', 'tag-fill', 'fill'));
        if (s.origin === 'edited') cell.appendChild(el('span', 'badge', 'edited'));
        if (isLockedName(s.mod)) cell.appendChild(el('span', 'badge', '📌 locked'));
        var augBadge = augmentBadge(s.mod);
        if (augBadge) cell.appendChild(el('span', 'badge', augBadge));
      }
      if (s.kind !== 'stance') {
        cell.addEventListener('click', function () { onCellClick(i); });
        cell.draggable = true;
        cell.addEventListener('dragstart', function (ev) {
          boardDragIdx = i;
          if (ev.dataTransfer) {
            try { ev.dataTransfer.setData('text/plain', String(i)); } catch (e) { /* noop */ }
          }
        });
        cell.addEventListener('dragover', function (ev) {
          if (ev.preventDefault) ev.preventDefault();
          cell.classList.add('dragover');
        });
        cell.addEventListener('dragleave', function () { cell.classList.remove('dragover'); });
        cell.addEventListener('drop', function (ev) {
          if (ev.preventDefault) ev.preventDefault();
          cell.classList.remove('dragover');
          var from = boardDragIdx;
          if (from < 0 && ev.dataTransfer) {
            var v = parseInt(ev.dataTransfer.getData('text/plain'), 10);
            if (Number.isInteger(v)) from = v;
          }
          boardDragIdx = -1;
          if (from >= 0 && from !== i && canSwapPos(from, i)) {
            swapPositions(from, i);
            boardSel = -1;
            afterBoardEdit();
          }
        });
      }
      box.appendChild(cell);
    });
  }

  function canSwapPos(a, b) {
    var ka = boardCur.slots[a].kind, kb = boardCur.slots[b].kind;
    return ka !== 'aura' && ka !== 'stance' && kb !== 'aura' && kb !== 'stance';
  }
  // Positions keep their kind / polarity / Forma plan; the PIECES
  // (mod, rank, origin) move — polarity belongs to the slot, not the mod.
  function swapPositions(a, b) {
    var A = boardCur.slots[a], B = boardCur.slots[b];
    var m = A.mod, r = A.rank, o = A.origin;
    A.mod = B.mod; A.rank = B.rank; A.origin = B.origin;
    B.mod = m; B.rank = r; B.origin = o;
  }
  function onCellClick(i) {
    if (boardSel >= 0 && boardSel !== i && canSwapPos(boardSel, i)) {
      swapPositions(boardSel, i);
      boardSel = -1;
      afterBoardEdit();
      return;
    }
    boardSel = i;
    $('board-swap').hidden = true;
    renderBoardGrid();
    renderBoardActions();
  }

  function renderBoardActions() {
    var bar = $('board-actions');
    var s = boardSel >= 0 ? boardCur.slots[boardSel] : null;
    if (!s || s.kind === 'stance') { bar.hidden = true; return; }
    bar.hidden = false;
    var normalIdx = 0, myIdx = 0;
    boardCur.slots.forEach(function (x, xi) {
      if (x.kind === 'normal') { normalIdx++; if (xi === boardSel) myIdx = normalIdx; }
    });
    $('board-sel-label').textContent = slotKindLabel(s, myIdx) + ': ' + (s.mod || '— empty —');
    $('btn-rank-down').disabled = !s.mod || s.kind === 'aura';
    $('btn-rank-up').disabled = !s.mod || s.kind === 'aura';
    $('btn-cell-remove').disabled = !s.mod;
    $('btn-cell-pin').disabled = !s.mod;
    $('btn-cell-pin').textContent = s.mod && isLockedName(s.mod) ? '📌 Unpin lock' : '📌 Pin as lock';
    $('btn-cell-ban').disabled = !s.mod || s.kind === 'aura';
    $('btn-cell-ban').textContent = s.mod && isExcludedMod(boardCatId || state.category, s.mod)
      ? 'Banned' : 'Ban this mod';
  }

  function afterBoardEdit() {
    syncBoardState();
    refreshBoardUI();
    lastPieces = collectBoardPieces();
    renderAcquisition();
  }

  function collectBoardPieces() {
    if (!boardCur) return [];
    var out = [];
    boardCur.slots.forEach(function (s) {
      if (!s.mod) return;
      out.push({
        name: s.mod,
        kind: s.kind === 'exilus' ? 'Exilus mod'
          : s.kind === 'aura' ? 'Aura'
          : s.kind === 'stance' ? 'Stance' : 'Mod'
      });
    });
    var e = boardCur.extras;
    if (boardKind === 'frame') {
      (e.arcanes || []).forEach(function (n) { out.push({ name: n, kind: 'Arcane' }); });
      (e.shards || []).forEach(function (sh) {
        out.push({ name: sh.colour + ' Archon Shard', kind: 'Archon Shard (' + sh.tier + ', ' + (FRAME_LABEL[sh.stat] || sh.stat) + ')' });
      });
      if (e.helmet) out.push({ name: e.helmet, kind: 'Legacy Arcane Helmet' });
      if (e.tome) out.push({ name: e.tome, kind: 'Tome mod (cross-gear)' });
      if (e.subsume) out.push({ name: e.subsume.ability, kind: 'Subsumed ability (from ' + e.subsume.fromFrame + ')' });
    } else if (e.arcane) {
      out.push({ name: e.arcane, kind: 'Arcane' });
    }
    return out;
  }

  var SINGLE_ELEMS = ['Heat', 'Cold', 'Electric', 'Toxin'];
  function modElement(name) {
    var rec = modRecord(name);
    if (!rec || !rec.effects) return null;
    var W = window.WeaponSolver._internal;
    for (var i = 0; i < rec.effects.length; i++) {
      var c = null;
      try { c = W.classifyEffect(rec.effects[i], rec.maxRank || 0); } catch (e) { c = null; }
      if (c && c.kind === 'typedAdd' && c.element) return c.element;
    }
    return null;
  }
  // "Slot 3 Cold + Slot 4 Toxin → Viral" — the modded elemental
  // sequence (progenitor first) folded with the solver's COMBO table.
  function elementalNote() {
    var W = window.WeaponSolver._internal;
    var COMBO = W.COMBO || {};
    function comboOf(a, b) { return COMBO[a + '|' + b] || COMBO[b + '|' + a] || null; }
    var seq = [];
    var ex = boardCur.extras;
    if (ex.progenitor && ex.progenitor.element) {
      seq.push({ element: ex.progenitor.element, label: 'Progenitor', combined: false });
    }
    var normalIdx = 0;
    boardCur.slots.forEach(function (s) {
      if (s.kind === 'normal') normalIdx++;
      if (s.kind !== 'normal' || !s.mod) return;
      var e = modElement(s.mod);
      if (e) seq.push({ element: e, label: 'Slot ' + normalIdx, combined: SINGLE_ELEMS.indexOf(e) < 0 });
    });
    var notes = [];
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i + 1 < seq.length; i++) {
        var a = seq[i], b = seq[i + 1];
        if (a.combined || b.combined || a.element === b.element) continue;
        var c = comboOf(a.element, b.element);
        if (c) {
          notes.push(a.label + ' ' + a.element + ' + ' + b.label + ' ' + b.element + ' → ' + c);
          seq.splice(i, 2, { element: c, label: a.label + '+' + b.label, combined: true });
          changed = true;
          break;
        }
      }
    }
    return notes.length ? 'Element sequence: ' + notes.join('; ') + '.' : '';
  }

  function boardDiffers() {
    if (!boardSolved || !boardCur) return false;
    if (boardSolved.slots.length !== boardCur.slots.length) return true;
    for (var i = 0; i < boardCur.slots.length; i++) {
      var a = boardSolved.slots[i], b = boardCur.slots[i];
      if (a.kind !== b.kind || a.mod !== b.mod || a.rank !== b.rank) return true;
    }
    return false;
  }

  function renderDelta(ev) {
    var panel = $('board-delta');
    if (!boardSolved || !boardDiffers()) { panel.hidden = true; return; }
    panel.hidden = false;
    var body = $('board-delta-body');
    body.innerHTML = '';
    var sd = boardStatDefs();
    var table = el('table', 'grid');
    var tb = document.createElement('tbody');
    var rows = 0;
    sd.defs.forEach(function (s) {
      var t = sd.store[s.key];
      if (!t || t.mode === 'dontcare') return;
      var sv = boardSolved.achieved ? boardSolved.achieved[s.key] : null;
      var cv = ev.achieved ? ev.achieved[s.key] : null;
      if (typeof sv !== 'number' || typeof cv !== 'number') return;
      if (Math.abs(cv - sv) < 1e-9) return;
      rows++;
      var tr = el('tr');
      tr.appendChild(el('td', null, s.label));
      tr.appendChild(el('td', null, fmt(sv) + ' → ' + fmt(cv)));
      var up = cv > sv;
      var cls = '', note = '';
      if (t.mode === 'atleast') {
        var tv = parseFloat(t.value);
        var broke = s.lowerBetter ? (cv > tv && sv <= tv) : (cv < tv && sv >= tv);
        var fixed = s.lowerBetter ? (cv <= tv && sv > tv) : (cv >= tv && sv < tv);
        if (broke) { cls = 'status-unmet'; note = ' — floor broken'; }
        else if (fixed) { cls = 'status-met'; note = ' — floor now met'; }
      } else if (t.mode === 'closest') {
        var tv2 = parseFloat(t.value);
        if (Math.abs(cv - tv2) > Math.abs(sv - tv2) + 1e-9) cls = 'status-unmet';
        else if (Math.abs(cv - tv2) < Math.abs(sv - tv2) - 1e-9) cls = 'status-met';
      } else if (t.mode === 'maximize') {
        cls = up ? 'status-met' : 'status-unmet';
      }
      var arrow = el('td', cls, (up ? '▲ ' : '▼ ') + fmt(Math.abs(cv - sv)) + note);
      arrow.className = (arrow.className ? arrow.className + ' ' : '') + 'delta-arrow';
      tr.appendChild(arrow);
      tb.appendChild(tr);
    });
    if (!rows) {
      body.appendChild(el('p', 'muted', 'Board edited — no targeted stat changed.'));
      return;
    }
    table.appendChild(tb);
    body.appendChild(table);
  }

  function refreshBoardUI() {
    var panel = $('board-panel');
    if (!boardCur || boardCatId !== state.category) {
      panel.hidden = true;
      $('guide-panel').hidden = true;
      return;
    }
    var ser = serializeBoard();
    if (!ser || ser.itemKey !== currentItemKey()) {
      panel.hidden = true;
      $('guide-panel').hidden = true;
      return;
    }
    panel.hidden = false;
    var ev = null, err = null;
    try { ev = evalBoard(); } catch (e) { err = e; }
    renderBoardGrid();
    renderBoardActions();
    var cap = $('board-capacity');
    if (err) {
      cap.textContent = 'Evaluation error: ' + err.message;
      cap.className = 'cap-over';
    } else {
      cap.className = ev.valid ? '' : 'cap-over';
      var rankCapNote = '';
      if (boardKind === 'weapon') {
        var bw = null;
        try { bw = currentWeapon(); } catch (e2) { bw = null; }
        if (bw && bw.entry.MaxRank && bw.entry.MaxRank > 30) {
          rankCapNote = ' · rank cap ' + bw.entry.MaxRank + ' (over-ranked via Forma)';
        }
      }
      cap.textContent = 'Capacity: ' + ev.capacityUsed + ' / ' + ev.capacityMax +
        ' · Forma: ' + ev.formaUsed +
        (ev.umbraFormaUsed ? ' · Umbra Forma: ' + ev.umbraFormaUsed : '') +
        (boardKind === 'weapon' && ev.overRankForma ? ' (incl. ' + ev.overRankForma + ' over-rank)' : '') +
        rankCapNote +
        (ev.valid ? '' : ' — OVER CAPACITY');
    }
    $('board-seq').textContent = boardKind === 'weapon' && !err ? elementalNote() : '';
    var wl = $('board-warnings');
    wl.innerHTML = '';
    if (ev) {
      ev.warnings.forEach(function (w) { wl.appendChild(el('li', null, w)); });
      if (!ev.valid) {
        wl.appendChild(el('li', null, 'Over capacity by ' + (ev.capacityUsed - ev.capacityMax) +
          ' — this arrangement needs more Forma headroom or fewer drain.'));
      }
    }
    if (ev) {
      var sd = boardStatDefs();
      achievedTable(sd.defs, sd.store, ev.achieved,
        computeUnmet(sd.defs, sd.store, ev.achieved), false, ev.breakdown);
      renderDelta(ev);
    }
    renderGuide();
  }

  // ---- board editor actions ---------------------------------------------------
  function selectedSlot() {
    return boardSel >= 0 && boardCur ? boardCur.slots[boardSel] : null;
  }
  function boardRankStep(delta) {
    var s = selectedSlot();
    if (!s || !s.mod || s.kind === 'aura' || s.kind === 'stance') return;
    var maxR = slotMaxRank(s.mod, s.kind);
    var nr = (s.rank || 0) + delta;
    if (nr < 0) nr = 0;
    if (maxR != null && nr > maxR) nr = maxR;
    if (nr === s.rank) return;
    s.rank = nr;
    afterBoardEdit();
  }
  function boardRemoveSelected() {
    var s = selectedSlot();
    if (!s || !s.mod) return;
    s.mod = null;
    s.rank = null;
    s.origin = 'target';
    $('board-swap').hidden = true;
    afterBoardEdit();
  }
  function boardOpenSwap() {
    var s = selectedSlot();
    if (!s || s.kind === 'stance') return;
    if (s.kind === 'aura') {
      swapPoolNames = (SITE.auras.mods || []).map(function (m) { return m.name; }).sort();
    } else {
      // v1.2: banned mods are never offered for swap-in.
      var banned = excludesFor(boardCatId || state.category).mods;
      swapPoolNames = pickerModNames(s.kind === 'exilus').filter(function (n) {
        return banned.indexOf(n) < 0;
      });
    }
    fillDatalist($('swap-list'), swapPoolNames);
    $('swap-search').value = '';
    $('board-swap').hidden = false;
  }
  function boardApplySwap() {
    var s = selectedSlot();
    if (!s) return;
    var name = $('swap-search').value.trim();
    if (swapPoolNames.indexOf(name) < 0) {
      $('calc-status').textContent = '"' + name + '" is not in this slot\'s legal pool.';
      return;
    }
    $('calc-status').textContent = '';
    s.mod = name;
    s.rank = slotMaxRank(name, s.kind);
    if (s.kind !== 'aura' && s.kind !== 'stance') s.origin = 'edited';
    $('board-swap').hidden = true;
    afterBoardEdit();
  }
  function boardTogglePin() {
    var s = selectedSlot();
    if (!s || !s.mod) return;
    var lk = locksFor(boardCatId || state.category);
    var idx = -1;
    lk.mods.forEach(function (L, i) { if (L.name === s.mod) idx = i; });
    if (idx >= 0) lk.mods.splice(idx, 1);
    else lk.mods.push({ name: s.mod, rank: s.rank == null ? (slotMaxRank(s.mod, s.kind) || 0) : s.rank });
    renderLockLists();
    saveState();
    refreshBoardUI();
  }
  // v1.2 "Ban this mod": add the selected cell's mod to the
  // category's excludes and take it off the board (re-evaluating
  // through the normal edit path). A locked mod must be unpinned
  // first — lock∩ban is a hard error in the engine.
  function boardBanSelected() {
    var s = selectedSlot();
    if (!s || !s.mod || s.kind === 'aura' || s.kind === 'stance') return;
    var name = s.mod;
    var catId = boardCatId || state.category;
    if (isLockedName(name)) {
      $('calc-status').textContent = name + ' is pinned as a lock — unpin it before banning.';
      return;
    }
    var ex = excludesFor(catId);
    if (ex.mods.indexOf(name) < 0) ex.mods.push(name);
    $('calc-status').textContent = '';
    s.mod = null;
    s.rank = null;
    s.origin = 'target';
    $('board-swap').hidden = true;
    renderLockLists();
    saveState();
    afterBoardEdit();
  }
  function boardReset() {
    if (!boardSolved) return;
    boardCur = { slots: cloneSlots(boardSolved.slots), extras: deepClone(boardSolved.extras) };
    boardSel = -1;
    $('board-swap').hidden = true;
    afterBoardEdit();
  }

  // Restore a board carried by state (share link / save) WITHOUT
  // running the solver: the board renders and is scored by the
  // evaluator only. Slot polarity meta falls back to the item's
  // innate polarities (a shared board carries no Forma plan).
  function restoreBoardFromState() {
    var b = state.board;
    if (!b || b.catId !== state.category) return;
    if (b.itemKey !== currentItemKey()) return;
    var cat = currentCat();
    boardKind = b.kind;
    boardCatId = b.catId;
    if (b.kind === 'frame') {
      if (cat.kind === 'companion') {
        var comp = null;
        try { comp = currentCompanion(); } catch (e) { comp = null; }
        boardItemName = comp ? comp.frameName : null;
      } else {
        boardItemName = state.selections[cat.id];
      }
    } else {
      var w = null;
      try { w = currentWeapon(); } catch (e2) { w = null; }
      boardItemName = w ? w.name : null;
      if (b.extras) b.extras.weaponName = boardItemName;
    }
    if (!boardItemName) { boardCur = null; return; }
    var innate = innatePolaritiesForBoard();
    var n = 0;
    var slots = b.slots.map(function (s) {
      var slot = {
        kind: s.kind, mod: s.mod, rank: s.rank,
        slotPolarity: null, innatePolarity: null,
        formaApplied: false, umbraFormaApplied: false,
        effectiveDrain: 0, origin: 'target'
      };
      if (s.kind === 'aura') slot.slotPolarity = slot.innatePolarity = innate.aura;
      else if (s.kind === 'stance') slot.slotPolarity = slot.innatePolarity = innate.stance;
      else if (s.kind === 'exilus') slot.slotPolarity = slot.innatePolarity = innate.exilus;
      else { slot.slotPolarity = slot.innatePolarity = innate.normals[n] || null; n++; }
      if ((s.kind === 'aura' || s.kind === 'stance') && s.mod) {
        // Capacity furniture: magnitude |baseDrain| + maxRank, doubled
        // on a polarity match (the solvers' own bonus rule).
        var rec = modRecord(s.mod);
        if (rec) {
          var mag = Math.abs(rec.baseDrain || 0) + (rec.maxRank || 0);
          if (rec.polarity && rec.polarity === slot.innatePolarity) mag *= 2;
          slot.effectiveDrain = -mag;
        }
      } else {
        var d = slotDrainInfo(slot);
        slot.effectiveDrain = d ? d.eff : 0;
      }
      return slot;
    });
    boardSolved = { slots: cloneSlots(slots), extras: deepClone(b.extras), achieved: null, unmetTargets: [] };
    boardCur = { slots: cloneSlots(slots), extras: deepClone(b.extras) };
    boardSel = -1;
    var ev = null;
    try { ev = evalBoard(); } catch (e3) { ev = null; }
    if (ev) boardSolved.achieved = ev.achieved;
    $('results-empty').hidden = true;
    $('results-body').hidden = false;
    var notes = $('result-notes');
    notes.innerHTML = '';
    notes.appendChild(el('li', null, 'Build restored from a share link / saved state — shown as-is and scored by the evaluator, not re-solved. Press Calculate to re-solve.'));
    $('capacity-line').textContent = '';
    $('cost-line').textContent = '';
    $('forma-line').innerHTML = '';
    $('cheapest-panel').hidden = true;
    $('helminth-card').hidden = true;
    $('crossgear-panel').hidden = true;
    $('peak-line').hidden = true;
    $('sustained-line').hidden = true;
    lastKind = b.kind;
    lastPieces = collectBoardPieces();
    refreshBoardUI();
  }
  function innatePolaritiesForBoard() {
    var cat = currentCat();
    var out = { aura: null, stance: null, exilus: null, normals: [] };
    try {
      if (boardKind === 'weapon') {
        var w = currentWeapon();
        if (w) {
          out.normals = (w.entry.Polarities || []).slice();
          out.stance = w.entry.StancePolarity || null;
          out.exilus = w.entry.ExilusPolarity || null;
        }
      } else if (cat.kind === 'frame') {
        var f = SITE.frames.warframes[state.selections.Warframe];
        if (f) { out.normals = (f.polarities || []).slice(); out.aura = f.auraPolarity || null; }
      } else if (cat.kind === 'necramech') {
        var m = SITE.frames.necramechs[state.selections.Necramech];
        if (m) out.normals = (m.Polarities || []).slice();
      } else if (cat.kind === 'companion') {
        var store = companionStoreEntry();
        var comp = currentCompanion();
        var e = (comp && comp.companionEntry) || store;
        if (e) out.normals = (e.Polarities || []).slice();
      }
    } catch (e) { /* honest empty meta */ }
    return out;
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
        arr.subsume.ability + ' (from ' + arr.subsume.fromFrame + ') replaces ' +
          (arr.subsumeReplaces || arr.subsume.replacedAbility)
      ]);
    }
    groupInto(box, 'Set bonuses (focus + support + planned cross-gear)', setBonusLines(res.setBonuses));
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
    groupInto(box, 'Set bonuses (focus + support + planned cross-gear)', setBonusLines(res.setBonuses));
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

  // v1.2: a forced NON-modelled Helminth donor rides as a build
  // instruction card — it never moved the solved stats, and the card
  // says so next to its diminished text.
  function renderHelminthCard(kind, res) {
    var card = $('helminth-card');
    var si = kind === 'frame' && res.arrangement ? res.arrangement.subsumeInstruction : null;
    if (!si) { card.hidden = true; return; }
    card.hidden = false;
    var body = $('helminth-card-body');
    body.innerHTML = '';
    body.appendChild(el('p', null,
      'Helminth: ' + si.donor + ' (' + si.donorFrame + ') replaces ' + si.replacesAbility +
      ' — not stat-modelled'));
    body.appendChild(el('p', 'muted', si.diminishedText || ''));
    body.appendChild(el('p', 'muted',
      'This subsume is in the build because you chose it; the paper stats above do not include it.'));
  }
  // v1.2: the prescriptive cross-gear plan — named mods on named
  // support gear, with the per-set totals the plan produces (planned
  // pieces already count in the set bonus lines above).
  function renderCrossGearResults(kind, res) {
    var panel = $('crossgear-panel');
    var cgOn = !!lastInput && !!lastInput.crossGear;
    if ((kind !== 'frame' && kind !== 'weapon') || !cgOn) { panel.hidden = true; return; }
    panel.hidden = false;
    var body = $('crossgear-body');
    body.innerHTML = '';
    var plan = res.crossGearPlan || [];
    if (!plan.length) {
      body.appendChild(el('p', 'muted', 'No reachable set completion from this build.'));
      return;
    }
    var ul = el('ul', 'plain');
    plan.forEach(function (p) {
      ul.appendChild(el('li', null, p.mod + ' → ' + p.gear + ' (' + p.set + ')'));
    });
    body.appendChild(ul);
    (res.setBonuses || []).forEach(function (sb) {
      if (!sb.plannedPieces) return;
      body.appendChild(el('p', 'muted',
        sb.set + ': ' + sb.pieces + ' pieces total (' + sb.focusPieces +
        ' on this item + ' + sb.plannedPieces + ' planned cross-gear' +
        (sb.supportPieces ? ' + ' + sb.supportPieces + ' legacy support' : '') + ').'));
    });
  }

  // ---- v1.3 sustained floor ------------------------------------------
  // Peak is the achieved table as before; when the solve carries a
  // sustained floor (intent set + conditional route on), the targeted
  // stats' burst-down values render as one compact line.
  function sustainedPairs(stats, store, achieved) {
    var pairs = [];
    if (!achieved) return pairs;
    stats.forEach(function (s) {
      var t = store[s.key];
      if (!t || t.mode === 'dontcare') return;
      var a = achieved[s.key];
      if (typeof a !== 'number') return;
      pairs.push(s.label + ' ' + fmt(a));
    });
    return pairs;
  }
  function resultStatsStore(kind) {
    if (kind === 'frame') {
      return {
        stats: currentCat().kind === 'companion' ? COMPANION_STATS : FRAME_STATS,
        store: state.frameTargets
      };
    }
    return { stats: WEAPON_STATS.concat(DMG_STATS), store: weaponTargetStore() };
  }
  function renderSustained(kind, res) {
    var peak = $('peak-line'), sus = $('sustained-line');
    peak.hidden = true; sus.hidden = true; sus.textContent = '';
    if ((kind !== 'frame' && kind !== 'weapon') || !res.sustained) return;
    var ss = resultStatsStore(kind);
    var pairs = sustainedPairs(ss.stats, ss.store, res.sustained.achieved);
    if (!pairs.length) return;
    peak.hidden = false;
    peak.textContent = 'Peak — all conditional effects up (the table below).';
    sus.hidden = false;
    sus.textContent = 'Sustained floor (burst effects down): ' + pairs.join(' · ');
  }
  function cheapestSustainedLine(kind, res) {
    if (!res.cheapest || !res.cheapest.sustained) return null;
    var ss = resultStatsStore(kind);
    var pairs = sustainedPairs(ss.stats, ss.store, res.cheapest.sustained.achieved);
    return pairs.length ? 'Sustained floor (burst effects down): ' + pairs.join(' · ') : null;
  }

  // ---- v1.3 guide: "How to get the most out of this build" ------------
  // Derived from the CURRENT build's pieces (live board + extras —
  // the same pieces the breakdown scores) joined to the shipped
  // conditional-class rows. No per-piece prose is invented; the one
  // exception is the Growing Power proc note, cited inline below.
  // Tacusin-confirmed in-game 2026-10-18: Growing Power procs come
  // from your weapons' status effects (companion weapons and Hunter
  // Munitions included); allies' status, ability status and
  // Syndicate radials do not trigger it.
  var GROWING_POWER_NOTE = "Procs from your weapons' status effects — incl. companion weapons and Hunter Munitions; not from allies, ability status, or Syndicate radials.";
  function pieceDescription(name) {
    var rec = null;
    (SITE.arcanes.arcanes || []).some(function (a) { if (a.name === name) { rec = a; return true; } return false; });
    if (!rec) (SITE.tomes.mods || []).some(function (a) { if (a.name === name) { rec = a; return true; } return false; });
    if (!rec) rec = modRecord(name);
    if (!rec) return null;
    if (rec.sourceLine) return rec.sourceLine;
    var effs = rec.effects || [];
    for (var i = 0; i < effs.length; i++) if (effs[i].sourceLine) return effs[i].sourceLine;
    return null;
  }
  function boardConditionalPieces() {
    var out = [];
    if (!boardCur) return out;
    function push(name) {
      var row = classRow(name);
      if (row) out.push({ name: name, row: row });
    }
    boardCur.slots.forEach(function (s) { if (s.mod) push(s.mod); });
    var e = boardCur.extras || {};
    if (boardKind === 'frame') {
      (e.arcanes || []).forEach(push);
      if (e.tome) push(e.tome);
      if (e.subsume) push(e.subsume.ability);
    } else if (boardKind === 'weapon') {
      if (e.arcane) push(e.arcane);
    }
    return out;
  }
  function isStacker(row) {
    return (row.maxStacks != null && row.maxStacks > 1) || /stack/i.test(row.trigger || '');
  }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function guideWindowText(row) {
    if (row.windowSeconds != null) return fmt(row.windowSeconds) + 's window';
    if (row.trigger && /^while/i.test(row.trigger)) return 'lasts ' + row.trigger.split(';')[0].trim();
    return 'no fixed window';
  }
  function fillWindup(body, pieces, heading) {
    body.appendChild(el('h3', null, heading || 'Wind-up sequence'));
    // Stack-builders first (they take the longest to arm), then by
    // window descending — the tightest window goes off LAST.
    var sorted = pieces.slice().sort(function (a, b) {
      var as = isStacker(a.row) ? 0 : 1, bs = isStacker(b.row) ? 0 : 1;
      if (as !== bs) return as - bs;
      var aw = a.row.windowSeconds == null ? Infinity : a.row.windowSeconds;
      var bw = b.row.windowSeconds == null ? Infinity : b.row.windowSeconds;
      if (aw !== bw) return bw - aw;
      return a.name < b.name ? -1 : 1;
    });
    var ol = el('ol', 'guide-steps');
    sorted.forEach(function (p) {
      var bits = [];
      if (isStacker(p.row) && p.row.maxStacks != null) bits.push('build to ' + p.row.maxStacks + ' stacks');
      bits.push(guideWindowText(p.row));
      var li = el('li', 'guide-step',
        p.name + ' — ' + cap1(p.row.trigger || 'conditional effect') + ' (' + bits.join(', ') + ')');
      if (p.name === 'Growing Power') li.textContent += ' ' + GROWING_POWER_NOTE;
      ol.appendChild(li);
    });
    ol.appendChild(el('li', 'guide-final', '→ then cast / fire the thing the build is built around.'));
    body.appendChild(ol);
  }
  function fillUpkeepCards(body, pieces) {
    body.appendChild(el('h3', null, 'Upkeep'));
    pieces.forEach(function (p) {
      var card = el('div', 'guide-card');
      card.appendChild(el('p', null, p.name + ' — ' + p.row.class +
        (p.row.windowSeconds != null ? ', ' + fmt(p.row.windowSeconds) + 's window' : '')));
      if (p.row.class === 'burst') {
        card.appendChild(el('p', 'guide-flag', isLockedName(p.name)
          ? 'Burst piece kept by lock — needs re-arming every ' + fmt(p.row.windowSeconds) + 's.'
          : 'Burst piece — needs re-arming every ' + fmt(p.row.windowSeconds) + 's in an upkeep build.'));
      } else if (p.row.trigger) {
        card.appendChild(el('p', 'muted', 'Stays up: ' + cap1(p.row.trigger) +
          (p.row.maxStacks != null && p.row.maxStacks > 1 ? ' — up to ' + p.row.maxStacks + ' stacks.' : '.')));
      }
      var desc = pieceDescription(p.name);
      if (desc) card.appendChild(el('p', 'muted', desc));
      if (p.name === 'Growing Power') card.appendChild(el('p', 'muted', GROWING_POWER_NOTE));
      body.appendChild(card);
    });
  }
  function fillGuideBody(body, pieces, condOn, hybridBurstNames) {
    body.innerHTML = '';
    if (!condOn || !pieces.length) {
      body.appendChild(el('p', 'muted', "Nothing conditional in this build — it's always on."));
      return;
    }
    if (state.intent === 'upkeep') { fillUpkeepCards(body, pieces); return; }
    if (state.intent === 'hybrid') {
      // v1.4: upkeep cards for everything that stays up (locked
      // burst pieces included — fillUpkeepCards flags them "kept by
      // lock"), plus a short wind-up listing ONLY the allowance
      // pieces: the solver-chosen burst set (result.hybridBurst on
      // an unedited board; on an edited board the non-locked burst
      // pieces are the window part by the same Q1 rule).
      var windowPieces = [], rest = [];
      pieces.forEach(function (p) {
        var isWindow = p.row.class === 'burst' &&
          (hybridBurstNames ? hybridBurstNames.indexOf(p.name) >= 0 : !isLockedName(p.name));
        (isWindow ? windowPieces : rest).push(p);
      });
      if (rest.length) fillUpkeepCards(body, rest);
      if (windowPieces.length) fillWindup(body, windowPieces, 'Window pieces (allowance)');
      return;
    }
    fillWindup(body, pieces);
  }
  function renderGuide() {
    var panel = $('guide-panel');
    if (!panel) return;
    if (!boardCur || boardCatId !== state.category) { panel.hidden = true; return; }
    var ser = serializeBoard();
    if (!ser || ser.itemKey !== currentItemKey()) { panel.hidden = true; return; }
    panel.hidden = false;
    var condOn = boardKind === 'frame' ? !!state.routesFrame.conditional : !!state.routesWeapon.conditional;
    // The engine's solver-chosen burst set names the hybrid window
    // part — trusted only while the board is the solved board; an
    // edited board re-derives it from the lock rule instead.
    var hybridNames = (state.intent === 'hybrid' && lastResult &&
      lastResult.hybridBurst && !boardDiffers()) ? lastResult.hybridBurst : null;
    fillGuideBody($('guide-body'), boardConditionalPieces(), condOn, hybridNames);
  }
  function renderGuideAmp(res) {
    var panel = $('guide-panel');
    if (!panel) return;
    panel.hidden = false;
    var pieces = [];
    ((res.arcanes && res.arcanes.amp) || []).concat((res.arcanes && res.arcanes.operator) || [])
      .forEach(function (n) {
        var row = classRow(n);
        if (row) pieces.push({ name: n, row: row });
      });
    fillGuideBody($('guide-body'), pieces, !!state.ampConditional);
  }

  function renderResults(kind, res) {
    lastResult = res;
    lastKind = kind;
    lastPieces = [];
    $('results-empty').hidden = true;
    $('results-body').hidden = false;
    var cat = currentCat();
    var arr = res.arrangement || {};
    if (kind === 'amp') $('board-panel').hidden = true;
    renderNotes(res);
    renderHelminthCard(kind, res);
    renderCrossGearResults(kind, res);
    renderSustained(kind, res);
    var box = $('arrangement');
    box.innerHTML = '';
    var dmg = $('damage-line');
    dmg.innerHTML = '';
    if (kind === 'frame') {
      var stats = cat.kind === 'companion' ? COMPANION_STATS : FRAME_STATS;
      achievedTable(stats, state.frameTargets, res.achieved, res.unmetTargets, false, res.breakdown);
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
      achievedTable(WEAPON_STATS.concat(DMG_STATS), weaponTargetStore(), res.achieved, res.unmetTargets, false, res.breakdown);
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
      var csLine = cheapestSustainedLine(kind, res);
      if (csLine) cbox.appendChild(el('p', 'muted', csLine));
    } else {
      cp.hidden = true;
    }
    if (!box.children.length) box.appendChild(el('p', 'muted', 'Empty build — no pieces needed for the current targets.'));
    // v1.1: the board (frame + weapon kinds) becomes the editable
    // source of truth for the achieved table from here on.
    if ((kind === 'frame' || kind === 'weapon') && res.arrangement && res.arrangement.slots) {
      setupBoard(kind, res);
      lastPieces = collectBoardPieces();
    }
    if (kind === 'amp') renderGuideAmp(res);
    renderAcquisition();
  }

  function renderAcquisition() {
    var hint = $('acq-hint');
    var table = $('acq-table');
    if (!lastResult && !boardCur) {
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
    lastInput = req.input;
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
      fetchJSON('data/acquisition.json'), fetchJSON('data/modpool.json'),
      fetchJSON('data/conditional_classes.json')
    ]).then(function (parts) {
      SITE = {
        frames: parts[0], weapons: parts[1], mods: parts[2], arcanes: parts[3],
        tomes: parts[4], auras: parts[5], shards: parts[6], helmets: parts[7],
        modular: parts[8], helminth: parts[9], setBonuses: parts[10],
        links: parts[11], acquisition: parts[12], modpool: parts[13],
        conditionalClasses: parts[14]
      };
      SITE.modpoolByName = {};
      (SITE.modpool.mods || []).forEach(function (m) { SITE.modpoolByName[m.name] = m; });
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
      $('btn-lock-mod').addEventListener('click', function () { addLockFromSearch('mod'); });
      $('btn-lock-arcane').addEventListener('click', function () { addLockFromSearch('arcane'); });
      $('btn-ban-mod').addEventListener('click', function () { addExcludeFromSearch('mod'); });
      $('btn-ban-arcane').addEventListener('click', function () { addExcludeFromSearch('arcane'); });
      $('btn-cg-include').addEventListener('click', addCrossGearInclude);
      $('btn-cg-exclude').addEventListener('click', addCrossGearExclude);
      $('btn-rank-down').addEventListener('click', function () { boardRankStep(-1); });
      $('btn-rank-up').addEventListener('click', function () { boardRankStep(1); });
      $('btn-cell-remove').addEventListener('click', boardRemoveSelected);
      $('btn-cell-swap').addEventListener('click', boardOpenSwap);
      $('btn-swap-apply').addEventListener('click', boardApplySwap);
      $('btn-swap-cancel').addEventListener('click', function () { $('board-swap').hidden = true; });
      $('btn-cell-pin').addEventListener('click', boardTogglePin);
      $('btn-cell-ban').addEventListener('click', boardBanSelected);
      $('btn-board-reset').addEventListener('click', boardReset);
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
      restoreBoardFromState();
      renderAcquisition();
    }).catch(function (e) {
      $('calc-status').textContent = 'Failed to load site data: ' + e.message;
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
