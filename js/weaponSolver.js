/*
 * weaponSolver.js — weapon paper-stat model + solver (S1).
 *
 * Plain JavaScript, no dependencies. Browser: window.WeaponSolver;
 * Node: module.exports. Companion to solver.js (frame solver) — same
 * target/mode/scoring discipline, separate stat model.
 *
 * Data bundle (no game data in this file). NOTE: the raw weapons store
 * is Python-flavored JSON (bare Infinity tokens — melee AmmoMax, Lanka
 * FireRate, Fluctus PunchThrough); whoever parses it for this solver
 * must normalize those first (tests do `: Infinity` -> null; the model
 * null-guards FireRate/PunchThrough to 0 until the site-data stage
 * picks final display semantics).
 *   data = {
 *     weapons:     data/raw/weapons_data.json  (flat name -> entry, or
 *                    {Weapons: {...}} — both accepted)
 *     modsEffects: data/derived/mods_effects.json ({mods: [...], sets})
 *     setBonuses:  data/derived/set_bonuses.json ({sets: {...}}, optional)
 *   }
 *
 * FORWARD MODEL — forward({weaponName, attackIndex, mods: [{name, rank}]
 * in SLOT ORDER, exilusMod, progenitor, arcaneEffects, conditional}, data)
 * computes the paper stats of ONE attack:
 *   - Base per-type damage from the attack's Damage dict.
 *   - Progenitor (Lich-family weapons only, IsLichWeapon in the data):
 *     adds percent% of total base damage as the progenitor element,
 *     treated as innate; it becomes part of the effective base that
 *     +damage% and elemental adds scale from.
 *   - Conversion mods (WEAPON_DAMAGE_TYPE_BIAS, "X% of Damage converted
 *     into <Type>"): shrink every damage type proportionally and add the
 *     converted amount to the target type. Applied to the effective
 *     base before adds (documented approximation of the game's order).
 *   - +damage% (WEAPON_DAMAGE_AMOUNT / WEAPON_MELEE_DAMAGE) scales every
 *     damage type, including elemental adds (canonical arsenal math:
 *     adds are computed off base, then the whole bucket scales).
 *   - Elemental adds (WEAPON_PERCENT_BASE_DAMAGE_ADDED, element read
 *     from the effect's sourceLine): an elemental add is percent% of
 *     TOTAL effective base damage; an IPS add (Impact/Puncture/Slash)
 *     is percent% of the effective base amount of THAT type only (the
 *     game's physical-mod rule — the reason Buzz Kill is weak on
 *     low-Slash weapons).
 *   - Element combining: sequence = [progenitor element] + [modded
 *     elemental adds in slot order] + [innate elemental types in Damage
 *     dict order]. Adjacent pairs of single elements fold via the
 *     standard table (Heat+Cold=Blast, Heat+Electric=Radiation,
 *     Heat+Toxin=Gas, Cold+Electric=Magnetic, Cold+Toxin=Viral,
 *     Electric+Toxin=Corrosive), repeatedly, until no adjacent single
 *     pair remains; combined elements never re-combine; IPS never
 *     combine; equal elements merge amounts. (Left-to-right folding of
 *     single-only pairs is equivalent to the game's (1,2),(3,4) pairing.)
 *   - CritChance_final = base x (1 + Sum crit%), CritMultiplier likewise,
 *     StatusChance likewise (plus flat "Final Status Chance" points),
 *     FireRate likewise, Multishot expected = base x (1 + Sum ms%).
 *     damagePerShot = totalDamage x multishotExpected.
 *   - Faction (Bane) multipliers apply on top and are exposed separately
 *     (factionMultiplier / factionAdjustedDamage) — never baked into
 *     damagePerShot. Per-rank faction value = 1 + (max-1) x (r+1)/(R+1).
 *   - Magazine = round(base x (1 + Sum%)) + flats. Reload final seconds
 *     = base / (1 + Sum reload%) (so reload targets are lower-better).
 *     PunchThrough = base + flats.
 *   - WEAPON_DAMAGE_IF_VICTIM_PROC_ACTIVE (Condition Overload) counts
 *     as +damage% ONCE (one status type) and only under the conditional
 *     route — paper stats cannot know the target's status count.
 *
 * POOL RULE (documented; the wiki store has no explicit compatibility
 * field for mods, so pools are built from the mod's Type + the weapon's
 * Class/Slot as the game allows):
 *   Primary:  Class Shotgun -> {Shotgun, Primary};
 *             Sniper Rifle -> {Sniper, Rifle, Assault Rifle, Primary};
 *             Bow -> {Bow, Rifle, Assault Rifle, Primary};
 *             otherwise -> {Rifle, Assault Rifle, Primary}.
 *   Secondary: {Pistol} (+ {Tome} when Class is Tome, e.g. Grimoire).
 *   Melee: {Melee} (+ {Thrown Melee} for Class Glaive).
 *   Archgun (incl. "Archgun (Atmosphere)"): {Archgun}. Archmelee: {Archmelee}.
 *   Beast (companion claws): {Claws}, with the Penjaga-polarity
 *   Claws-type posture mods as its stance pool (the Claws type mixes
 *   melee stances and beast postures in the store; Penjaga separates
 *   them, and melee Claws weapons exclude Penjaga entries in return).
 *   Hound: {Melee}. Robotic (sentinel weapons): the standard pool for
 *   the weapon's Class (Rifle/Shotgun/Sniper/Bow/Pistol/Glaive rules).
 *   Every pool also admits mods whose Type equals the weapon's Name or
 *   Family (weapon-specific mods/augments). Stance mods are a separate
 *   pool: Type = the weapon's stance class (from its *_STANCE
 *   CompatibilityTag, falling back to Class), identified by negative
 *   BaseDrain — they add capacity, never stats.
 *
 * CAPACITY: Orokin Catalyst assumed installed (capacity = rank cap x 2;
 * output notes say so). Melee stance adds capacity like an aura:
 * magnitude |baseDrain| + rank at max rank, doubled when its polarity
 * matches the weapon's StancePolarity. Over-rank: weapons whose data
 * MaxRank is 40 (Lich-family + Paracesis + a few others) need Forma to
 * pass rank 30 — each Forma buys +2 cap, max 5, drawn from the same
 * Forma budget as polarity fitting. Regular Forma cannot match an
 * Umbra-polarity mod (Sacrificial set); input.umbraForma (default 0)
 * is the separate budget for that, mirroring solver.js.
 *
 * The arcane slot (S2): pass the full arcane pool as
 * data.arcaneEffects (data/derived/arcane_effects_full.json) and the
 * solver searches the one arcane slot over pool entries whose Type
 * matches the weapon (Primary/Secondary/Melee/Archgun families;
 * Shotgun/Bow types match those Classes; Robotic weapons match by
 * Class). routes.arcanes gates the search (default on when a pool is
 * present). Callers may still inject anonymous arcaneEffects directly
 * (forward input / solve input) — that bypasses the pool search.
 * arcaneEffectsForEntry converts one pool entry to forward-ready
 * effect objects (absolute max-rank values; multiplier units become
 * (x-1)*100 percent for damage/crit kinds).
 * Cheapest-variant output is frame-solver only (separate
 * implementation, not shared code).
 */
(function () {
  'use strict';

  var IPS = ['Impact', 'Puncture', 'Slash'];
  var SINGLE_ELEMS = ['Heat', 'Cold', 'Electric', 'Toxin'];
  var COMBINED_ELEMS = ['Blast', 'Radiation', 'Gas', 'Magnetic', 'Viral', 'Corrosive'];
  var COMBO = {
    'Cold|Heat': 'Blast', 'Electric|Heat': 'Radiation', 'Heat|Toxin': 'Gas',
    'Cold|Electric': 'Magnetic', 'Cold|Toxin': 'Viral',
    'Electric|Toxin': 'Corrosive'
  };
  function comboOf(a, b) {
    return COMBO[a + '|' + b] || COMBO[b + '|' + a] || null;
  }
  function isElem(t) { return SINGLE_ELEMS.indexOf(t) >= 0 || COMBINED_ELEMS.indexOf(t) >= 0; }
  function isSingleElem(t) { return SINGLE_ELEMS.indexOf(t) >= 0; }

  // Melee stance class types in the wiki store (stance mods carry one of
  // these as their Type and a negative BaseDrain).
  var STANCE_TYPES = ['Swords', 'Warfans', 'Rapiers', 'Daggers', 'Blade And Whip',
    'Staves', 'Heavy Blade', 'Gunblade', 'Claws', 'Scythes', 'Heavy Scythe',
    'Hammers', 'Sword And Shield', 'Machetes', 'Fists', 'Sparring', 'Bayonet',
    'Nikanas', 'Whips', 'Dual Swords', 'Dual Nikanas', 'Two-Handed Nikana',
    'Polearms', 'Dual Daggers', 'Tonfas', 'Glaives', 'Nunchaku', 'Assault Saw'];
  // *_STANCE CompatibilityTag stem -> stance mod Type.
  var STANCE_STEM_MAP = {
    SWORDS: 'Swords', WARFAN: 'Warfans', RAPIER: 'Rapiers', DAGGERS: 'Daggers',
    BLADE_AND_WHIP: 'Blade And Whip', STAVES: 'Staves', HEAVY_BLADE: 'Heavy Blade',
    GUNBLADE: 'Gunblade', CLAWS: 'Claws', SCYTHES: 'Scythes',
    'HEAVY SCYTHE': 'Heavy Scythe', HAMMERS: 'Hammers',
    SWORDS_AND_SHIELD: 'Sword And Shield', MACHETES: 'Machetes', FIST: 'Fists',
    SPARRING: 'Sparring', BAYONET: 'Bayonet', NIKANAS: 'Nikanas', WHIPS: 'Whips',
    DUAL_SWORDS: 'Dual Swords', DUAL_KATANAS: 'Dual Nikanas',
    LONG_KATANA: 'Two-Handed Nikana', BLADESAW: 'Assault Saw',
    POLEARMS: 'Polearms', DUAL_DAGGERS: 'Dual Daggers', TONFA: 'Tonfas',
    GLAIVES: 'Glaives', NUNCHAKU: 'Nunchaku', SCYTHE: 'Scythes'
  };
  var CLASS_TO_STANCE_TYPE = {
    Sword: 'Swords', Warfan: 'Warfans', Rapier: 'Rapiers', Dagger: 'Daggers',
    'Blade and Whip': 'Blade And Whip', Staff: 'Staves', 'Heavy Blade': 'Heavy Blade',
    Gunblade: 'Gunblade', Claws: 'Claws', Scythe: 'Scythes',
    'Heavy Scythe': 'Heavy Scythe', Hammer: 'Hammers',
    'Sword and Shield': 'Sword And Shield', Machete: 'Machetes', Fist: 'Fists',
    Sparring: 'Sparring', Bayonet: 'Bayonet', Nikana: 'Nikanas', Whip: 'Whips',
    'Dual Swords': 'Dual Swords', 'Dual Nikanas': 'Dual Nikanas',
    'Two-Handed Nikana': 'Two-Handed Nikana', 'Assault Saw': 'Assault Saw',
    Polearm: 'Polearms', 'Dual Daggers': 'Dual Daggers', Tonfa: 'Tonfas',
    Glaive: 'Glaives', Nunchaku: 'Nunchaku'
  };

  var STAT_KEYS = ['totalDamagePerShot', 'critChance', 'critMultiplier',
    'statusChance', 'fireRate', 'multishot', 'magazine', 'reload', 'punchThrough'];
  var DEFAULT_LOWER_BETTER = { reload: true };

  // ---- fusion (ranking) costs ------------------------------------------------
  // Same verified table as solver.js (wiki "Fusion" page, Stage S2):
  // cost from rank 0 to R = base x (2^R - 1); Endo bases Common 10 /
  // Uncommon 20 / Rare 30 / Legendary 40, Credits bases 483 / 966 /
  // 1449 / 1932; Antique mods use 160/320/480 and 5000/10000/15000.
  var FUSION_ENDO = { Common: 10, Uncommon: 20, Rare: 30, Legendary: 40 };
  var FUSION_CREDITS = { Common: 483, Uncommon: 966, Rare: 1449, Legendary: 1932 };
  var FUSION_ENDO_ANTIQUE = { Common: 160, Uncommon: 320, Rare: 480 };
  var FUSION_CREDITS_ANTIQUE = { Common: 5000, Uncommon: 10000, Rare: 15000 };
  function rankCostFor(rec, rank) {
    if (!rec || !rank || rank <= 0) return { endo: 0, credits: 0 };
    var antique = rec.type === 'Antique';
    var eBase = (antique ? FUSION_ENDO_ANTIQUE : FUSION_ENDO)[rec.rarity];
    var cBase = (antique ? FUSION_CREDITS_ANTIQUE : FUSION_CREDITS)[rec.rarity];
    if (typeof eBase !== 'number' || typeof cBase !== 'number') return null;
    var f = Math.pow(2, rank) - 1;
    return { endo: eBase * f, credits: cBase * f };
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  // ---- effect classification ---------------------------------------------
  // Damage-type word at the end of a sourceLine like
  // "+90% <DT_FIRE_COLOR>Heat" -> "Heat" ("Electricity" -> "Electric").
  function elementFromSourceLine(line) {
    if (!line) return null;
    var m = /<DT_[A-Z_]+>\s*([A-Za-z]+)/.exec(line);
    if (!m) return null;
    var w = m[1];
    if (w === 'Electricity') w = 'Electric';
    if (w === 'Poison') w = 'Toxin';
    return (IPS.indexOf(w) >= 0 || isElem(w)) ? w : null;
  }

  // Map one derived effect to a weapon-model effect, or null when it does
  // not move a modelled stat. Percent/flat kinds carry valuePerRank;
  // faction carries the max-rank multiplier (per-rank is nonlinear).
  function classifyEffect(e, maxRank) {
    var vpr = (typeof e.valuePerRank === 'number')
      ? e.valuePerRank : e.value / ((maxRank || 0) + 1);
    var base = { conditional: e.condition || null };
    switch (e.upgradeType) {
      case 'WEAPON_DAMAGE_AMOUNT':
      case 'WEAPON_MELEE_DAMAGE':
        if (e.unit !== 'percent') return null;
        return Object.assign(base, { kind: 'damagePct', valuePerRank: vpr });
      case 'WEAPON_DAMAGE_IF_VICTIM_PROC_ACTIVE':
        if (e.unit !== 'percent') return null;
        // Condition Overload family: proc-scaling damage, counted once
        // under the conditional route (see header).
        return Object.assign(base, { kind: 'damagePct', valuePerRank: vpr, conditional: base.conditional || 'perStatusType' });
      case 'WEAPON_PERCENT_BASE_DAMAGE_ADDED': {
        if (e.unit !== 'percent') return null;
        var el = elementFromSourceLine(e.sourceLine);
        if (!el) return null;
        return Object.assign(base, { kind: 'typedAdd', element: el, valuePerRank: vpr });
      }
      case 'WEAPON_DAMAGE_TYPE_BIAS': {
        if (e.unit !== 'percent') return null;
        var el2 = elementFromSourceLine(e.sourceLine);
        if (!el2) return null;
        return Object.assign(base, { kind: 'convert', element: el2, valuePerRank: vpr });
      }
      case 'WEAPON_CRIT_CHANCE':
        return e.unit === 'percent' ? Object.assign(base, { kind: 'critPct', valuePerRank: vpr }) : null;
      case 'WEAPON_CRIT_DAMAGE':
        return e.unit === 'percent' ? Object.assign(base, { kind: 'critDmgPct', valuePerRank: vpr }) : null;
      case 'WEAPON_PROC_CHANCE':
        if (e.unit === 'percent') return Object.assign(base, { kind: 'statusPct', valuePerRank: vpr });
        if (e.unit === 'flat') return Object.assign(base, { kind: 'statusFlat', valuePerRank: vpr });
        return null;
      case 'WEAPON_FIRE_RATE':
        return e.unit === 'percent' ? Object.assign(base, { kind: 'fireRatePct', valuePerRank: vpr }) : null;
      case 'WEAPON_FIRE_ITERATIONS':
        return e.unit === 'percent' ? Object.assign(base, { kind: 'multishotPct', valuePerRank: vpr }) : null;
      case 'WEAPON_CLIP_MAX':
        if (e.unit === 'percent') return Object.assign(base, { kind: 'magPct', valuePerRank: vpr });
        if (e.unit === 'flat') return Object.assign(base, { kind: 'magFlat', valuePerRank: vpr });
        return null;
      case 'WEAPON_RELOAD_SPEED':
        return e.unit === 'percent' ? Object.assign(base, { kind: 'reloadPct', valuePerRank: vpr }) : null;
      case 'WEAPON_PUNCTURE_DEPTH':
        return e.unit === 'flat' ? Object.assign(base, { kind: 'punchFlat', valuePerRank: vpr }) : null;
      case 'GAMEPLAY_FACTION_DAMAGE':
        if (e.unit !== 'multiplier') return null;
        return Object.assign(base, { kind: 'faction', maxValue: e.value, maxRank: maxRank || 0 });
      default:
        return null;
    }
  }

  function buildContext(data) {
    var ctx = {};
    var w = data.weapons || {};
    ctx.weapons = w.Weapons || w;
    ctx.modPool = [];
    ctx.stancesByType = {};
    ctx.setOfMod = {};
    var mods = (data.modsEffects && data.modsEffects.mods) || [];
    mods.forEach(function (m) {
      if (m.set) ctx.setOfMod[m.name] = m.set;
      // Stance pool: melee-class Type + negative BaseDrain (capacity mods).
      if (STANCE_TYPES.indexOf(m.type) >= 0 && (m.baseDrain || 0) < 0) {
        (ctx.stancesByType[m.type] = ctx.stancesByType[m.type] || []).push({
          name: m.name, polarity: m.polarity || null,
          baseDrain: m.baseDrain, maxRank: m.maxRank || 0
        });
        return;
      }
      if (m.parseStatus !== 'clean' && m.parseStatus !== 'partial') return;
      var effs = [];
      (m.effects || []).forEach(function (e) {
        var c = classifyEffect(e, m.maxRank || 0);
        if (c) effs.push(c);
      });
      if (!effs.length) return;
      ctx.modPool.push({
        name: m.name, type: m.type || null, polarity: m.polarity || null,
        baseDrain: m.baseDrain || 0, rarity: m.rarity || null,
        maxRank: m.maxRank || 0,
        incompatible: m.incompatible || [], set: m.set || null,
        exilus: !!m.exilus, effects: effs
      });
    });
    ctx.modByName = {};
    ctx.modPool.forEach(function (m) { ctx.modByName[m.name] = m; });

    // Full arcane pool (S2): raw entries from
    // data/derived/arcane_effects_full.json; conversion to forward
    // effects happens per entry in arcaneEffectsForEntry.
    ctx.arcanePool = (data.arcaneEffects && data.arcaneEffects.arcanes) || [];

    ctx.setBonuses = {};
    var sbData = (data.setBonuses && data.setBonuses.sets) || {};
    Object.keys(sbData).forEach(function (name) {
      var s = sbData[name] || {};
      ctx.setBonuses[name] = {
        perPiece: Array.isArray(s.perPiece) ? s.perPiece : null,
        parseStatus: s.parseStatus || 'prose',
        sourceText: s.sourceText || ''
      };
    });
    return ctx;
  }

  // ---- arcane pool ------------------------------------------------------------
  var ARCANE_KINDS = ['damagePct', 'critPct', 'critDmgPct', 'statusPct',
    'statusFlat', 'fireRatePct', 'multishotPct', 'magPct', 'magFlat',
    'reloadPct', 'punchFlat', 'typedAdd'];
  // Convert one full-pool arcane entry to forward-ready effects:
  // absolute max-rank `value`s, kinds as applyEffect expects.
  // Non-numeric values (unbounded per-stack parses) are skipped.
  function arcaneEffectsForEntry(entry) {
    var out = [];
    (entry.effects || []).forEach(function (e) {
      if (typeof e.value !== 'number') return;
      if (ARCANE_KINDS.indexOf(e.stat) < 0) return;
      var val = e.value;
      if (e.unit === 'multiplier') {
        if (e.stat === 'damagePct' || e.stat === 'critPct' ||
            e.stat === 'critDmgPct') {
          val = (val - 1) * 100;
        } else return;
      }
      var eff = {
        kind: e.stat, value: val,
        conditional: e.conditional ? (entry.condition || 'conditional') : null
      };
      if (e.stat === 'typedAdd') {
        if (!e.element) return;
        eff.element = e.element;
      }
      out.push(eff);
    });
    return out;
  }

  // Which pool Types may sit on this weapon. Shotgun/Bow arcane types
  // are Primary-slot arcanes restricted by weapon Class; Robotic
  // (sentinel) weapons match by their Class like normal weapons.
  function arcaneTypeMatches(entry, weapon) {
    var t = entry.type;
    var slot = weapon.Slot;
    function primaryFamily() {
      return t === 'Primary' ||
        (t === 'Shotgun' && weapon.Class === 'Shotgun') ||
        (t === 'Bow' && weapon.Class === 'Bow');
    }
    if (slot === 'Primary') return primaryFamily();
    if (slot === 'Secondary') return t === 'Secondary';
    if (slot === 'Melee') return t === 'Melee';
    if (slot === 'Archgun' || slot === 'Archgun (Atmosphere)') return t === 'Archgun';
    if (slot === 'Archmelee') return t === 'Archmelee';
    if (slot === 'Robotic') {
      if (weapon.Class === 'Pistol') return t === 'Secondary';
      if (weapon.Class === 'Glaive') return t === 'Melee';
      return primaryFamily();
    }
    return false;
  }

  function stanceTypeFor(weapon) {
    var tags = weapon.CompatibilityTags || [];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (/_STANCE$/.test(t)) {
        var stem = t.replace(/_STANCE$/, '').replace(/_STANCE$/, '');
        if (STANCE_STEM_MAP[stem]) return STANCE_STEM_MAP[stem];
      }
    }
    if (CLASS_TO_STANCE_TYPE[weapon.Class]) return CLASS_TO_STANCE_TYPE[weapon.Class];
    var zaw = /^Zaw (.+?) \//.exec(weapon.Class || '');
    if (zaw && CLASS_TO_STANCE_TYPE[zaw[1]]) return CLASS_TO_STANCE_TYPE[zaw[1]];
    return null;
  }

  function poolFor(ctx, weapon) {
    var slot = weapon.Slot;
    var types = null;
    if (slot === 'Primary') {
      if (weapon.Class === 'Shotgun') types = ['Shotgun', 'Primary'];
      else if (weapon.Class === 'Sniper Rifle') types = ['Sniper', 'Rifle', 'Assault Rifle', 'Primary'];
      else if (weapon.Class === 'Bow') types = ['Bow', 'Rifle', 'Assault Rifle', 'Primary'];
      else types = ['Rifle', 'Assault Rifle', 'Primary'];
    } else if (slot === 'Secondary') {
      types = ['Pistol'];
      if (weapon.Class === 'Tome') types.push('Tome');
    } else if (slot === 'Melee') {
      types = ['Melee'];
      if (weapon.Class === 'Glaive') types.push('Thrown Melee');
    } else if (slot === 'Archgun' || slot === 'Archgun (Atmosphere)') {
      types = ['Archgun'];
    } else if (slot === 'Archmelee') {
      types = ['Archmelee'];
    } else if (slot === 'Beast') {
      // Companion claws: their own Claws-type mod pool.
      types = ['Claws'];
    } else if (slot === 'Hound') {
      // Hound weapons are melee weapons wielded by the hound.
      types = ['Melee'];
    } else if (slot === 'Robotic') {
      // Sentinel weapons use the standard pools for their Class.
      if (weapon.Class === 'Shotgun') types = ['Shotgun', 'Primary'];
      else if (weapon.Class === 'Sniper Rifle') types = ['Sniper', 'Rifle', 'Assault Rifle', 'Primary'];
      else if (weapon.Class === 'Bow') types = ['Bow', 'Rifle', 'Assault Rifle', 'Primary'];
      else if (weapon.Class === 'Pistol') types = ['Pistol'];
      else if (weapon.Class === 'Glaive') types = ['Melee', 'Thrown Melee'];
      else types = ['Rifle', 'Assault Rifle', 'Primary'];
    }
    if (!types) return { mods: [], stances: [], slotSupported: false };
    var mods = ctx.modPool.filter(function (m) {
      return types.indexOf(m.type) >= 0 || m.type === weapon.Name ||
             (weapon.Family && m.type === weapon.Family);
    });
    var stances = [];
    if (slot === 'Melee') {
      var st = stanceTypeFor(weapon);
      if (st) {
        stances = (ctx.stancesByType[st] || []).slice();
        // The Claws type mixes melee stances with beast POSTURE mods;
        // postures carry the companion-only Penjaga polarity and never
        // belong on a melee weapon (and vice versa, below).
        if (st === 'Claws') {
          stances = stances.filter(function (s) { return s.polarity !== 'Penjaga'; });
        }
      }
    } else if (slot === 'Beast') {
      // Beast posture slot: only the Penjaga-polarity Claws-type mods.
      stances = (ctx.stancesByType.Claws || []).filter(function (s) {
        return s.polarity === 'Penjaga';
      });
    }
    return { mods: mods, stances: stances, slotSupported: true };
  }

  // ---- forward model -------------------------------------------------------
  // placed: [{rec, rank}] in slot order. arcaneEffects: mapped-effect
  // objects with absolute `value` (and `element` for typedAdd/convert).
  function forwardCalc(ctx, weapon, attackIndex, placed, opts) {
    opts = opts || {};
    var attacks = weapon.Attacks || [];
    var ai = (typeof attackIndex === 'number') ? attackIndex
      : ((weapon._TooltipAttackDisplay || 1) - 1);
    if (ai < 0 || ai >= attacks.length) ai = 0;
    var attack = attacks[ai] || {};
    var dmg = attack.Damage || {};

    var acc = { damagePct: 0, critPct: 0, critDmgPct: 0, statusPct: 0,
      statusFlat: 0, fireRatePct: 0, multishotPct: 0, magPct: 0, magFlat: 0,
      reloadPct: 0, punchFlat: 0, faction: 1, typedAdds: [], converts: [] };
    function applyEffect(eff, value) {
      switch (eff.kind) {
        case 'damagePct': acc.damagePct += value; break;
        case 'critPct': acc.critPct += value; break;
        case 'critDmgPct': acc.critDmgPct += value; break;
        case 'statusPct': acc.statusPct += value; break;
        case 'statusFlat': acc.statusFlat += value; break;
        case 'fireRatePct': acc.fireRatePct += value; break;
        case 'multishotPct': acc.multishotPct += value; break;
        case 'magPct': acc.magPct += value; break;
        case 'magFlat': acc.magFlat += value; break;
        case 'reloadPct': acc.reloadPct += value; break;
        case 'punchFlat': acc.punchFlat += value; break;
        case 'typedAdd': acc.typedAdds.push({ element: eff.element, pct: value }); break;
        case 'convert': acc.converts.push({ element: eff.element, pct: value }); break;
        case 'faction': acc.faction *= value; break;
      }
    }
    function applyMod(rec, rank) {
      rec.effects.forEach(function (eff) {
        if (eff.conditional && !opts.conditional) return;
        if (eff.kind === 'faction') {
          var frac = (rank + 1) / ((eff.maxRank || 0) + 1);
          applyEffect(eff, 1 + (eff.maxValue - 1) * frac);
        } else {
          applyEffect(eff, eff.valuePerRank * (rank + 1));
        }
      });
    }
    placed.forEach(function (p) { applyMod(p.rec, p.rank); });
    (opts.arcaneEffects || []).forEach(function (eff) {
      if (eff.conditional && !opts.conditional) return;
      if (typeof eff.value === 'number' && eff.kind) applyEffect(eff, eff.value);
    });

    // Effective base distribution.
    var baseTotal = 0;
    Object.keys(dmg).forEach(function (k) { baseTotal += dmg[k] || 0; });
    var ips = { Impact: dmg.Impact || 0, Puncture: dmg.Puncture || 0, Slash: dmg.Slash || 0 };
    var effIpsBase = { Impact: ips.Impact, Puncture: ips.Puncture, Slash: ips.Slash };
    var innateElems = [];
    Object.keys(dmg).forEach(function (k) {
      if (isElem(k) && dmg[k]) {
        innateElems.push({ element: k, amount: dmg[k], combined: !isSingleElem(k) });
      }
    });
    var progComponent = null, progAmt = 0;
    if (opts.progenitor && weapon.IsLichWeapon && opts.progenitor.element) {
      var pe = opts.progenitor.element;
      if (pe === 'Electricity') pe = 'Electric';
      if (pe === 'Poison') pe = 'Toxin';
      progAmt = baseTotal * (opts.progenitor.percent || 0) / 100;
      if (IPS.indexOf(pe) >= 0) {
        ips[pe] += progAmt; effIpsBase[pe] += progAmt;
      } else if (isElem(pe)) {
        progComponent = { element: pe, amount: progAmt, combined: !isSingleElem(pe) };
      } else {
        progAmt = 0;
      }
    }
    var effBaseTotal = baseTotal + progAmt;

    // Conversions: shrink everything proportionally, top up the target.
    acc.converts.forEach(function (cv) {
      var total = ips.Impact + ips.Puncture + ips.Slash +
        innateElems.reduce(function (s, c) { return s + c.amount; }, 0) +
        (progComponent ? progComponent.amount : 0);
      if (total <= 0) return;
      var p = Math.min(100, Math.max(0, cv.pct)) / 100;
      var amt = total * p;
      IPS.forEach(function (t) { ips[t] *= (1 - p); });
      innateElems.forEach(function (c) { c.amount *= (1 - p); });
      if (progComponent) progComponent.amount *= (1 - p);
      if (IPS.indexOf(cv.element) >= 0) {
        ips[cv.element] += amt;
      } else {
        var found = null;
        innateElems.forEach(function (c) { if (c.element === cv.element) found = c; });
        if (found) found.amount += amt;
        else innateElems.push({ element: cv.element, amount: amt, combined: !isSingleElem(cv.element) });
      }
    });

    // Modded elemental adds; IPS adds merge straight into the IPS bucket.
    var moddedElems = [];
    acc.typedAdds.forEach(function (ta) {
      if (IPS.indexOf(ta.element) >= 0) {
        ips[ta.element] += effIpsBase[ta.element] * ta.pct / 100;
      } else if (isElem(ta.element)) {
        moddedElems.push({ element: ta.element, amount: effBaseTotal * ta.pct / 100, combined: !isSingleElem(ta.element) });
      }
    });

    // Combining sequence: progenitor, modded (slot order), innate.
    var seq = [];
    if (progComponent) seq.push(progComponent);
    seq = seq.concat(moddedElems, innateElems);
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i + 1 < seq.length; i++) {
        var a = seq[i], b = seq[i + 1];
        if (a.combined || b.combined || a.element === b.element) continue;
        var c = comboOf(a.element, b.element);
        if (c) {
          seq.splice(i, 2, { element: c, amount: a.amount + b.amount, combined: true });
          changed = true;
          break;
        }
      }
    }

    var dist = {};
    IPS.forEach(function (t) { if (ips[t]) dist[t] = ips[t]; });
    seq.forEach(function (c) {
      if (c.amount) dist[c.element] = (dist[c.element] || 0) + c.amount;
    });
    var scaleF = 1 + acc.damagePct / 100;
    var totalDamage = 0;
    Object.keys(dist).forEach(function (k) { dist[k] *= scaleF; totalDamage += dist[k]; });

    var multishot = (attack.Multishot || 1) * (1 + acc.multishotPct / 100);
    var critChance = (attack.CritChance || 0) * 100 * (1 + acc.critPct / 100);
    var statusChance = (attack.StatusChance || 0) * 100 * (1 + acc.statusPct / 100) + acc.statusFlat;
    return {
      attackIndex: ai,
      attackName: attack.AttackName || null,
      damageByType: dist,
      totalDamage: totalDamage,
      multishot: multishot,
      damagePerShot: totalDamage * multishot,
      critChance: critChance,
      critMultiplier: (attack.CritMultiplier || 1) * (1 + acc.critDmgPct / 100),
      statusChance: statusChance,
      fireRate: (attack.FireRate || 0) * (1 + acc.fireRatePct / 100),
      magazine: (weapon.Magazine != null)
        ? Math.round(weapon.Magazine * (1 + acc.magPct / 100)) + acc.magFlat : null,
      reload: (weapon.Reload != null)
        ? weapon.Reload / Math.max(0.05, 1 + acc.reloadPct / 100) : null,
      punchThrough: (attack.PunchThrough || 0) + acc.punchFlat,
      factionMultiplier: acc.faction,
      factionAdjustedDamage: totalDamage * acc.faction
    };
  }

  function forward(input, data) {
    var ctx = buildContext(data);
    var weapon = ctx.weapons[input.weaponName];
    if (!weapon) throw new Error('Unknown weapon: ' + input.weaponName);
    var placed = (input.mods || []).map(function (m) {
      var rec = ctx.modByName[m.name];
      if (!rec) throw new Error('Unknown or unmodelled mod: ' + m.name);
      return { rec: rec, rank: (typeof m.rank === 'number') ? m.rank : rec.maxRank };
    });
    if (input.exilusMod) {
      var er = ctx.modByName[input.exilusMod.name];
      if (!er) throw new Error('Unknown or unmodelled mod: ' + input.exilusMod.name);
      placed.push({ rec: er, rank: (typeof input.exilusMod.rank === 'number') ? input.exilusMod.rank : er.maxRank });
    }
    var arcaneEffects = input.arcaneEffects || null;
    if (!arcaneEffects && input.arcaneName) {
      // Named pool arcane: applies only when its Type matches this
      // weapon (a mismatched arcane simply does not fit the slot).
      var entry = null;
      ctx.arcanePool.forEach(function (a) { if (a.name === input.arcaneName) entry = a; });
      arcaneEffects = (entry && arcaneTypeMatches(entry, weapon))
        ? arcaneEffectsForEntry(entry) : [];
    }
    return forwardCalc(ctx, weapon, input.attackIndex, placed, {
      conditional: !!input.conditional,
      progenitor: input.progenitor || null,
      arcaneEffects: arcaneEffects
    });
  }

  // ---- capacity fitting ------------------------------------------------------
  function polMatches(slotPol, modPol) {
    return !!slotPol && !!modPol && (slotPol === modPol || slotPol === 'Universal');
  }
  function drainAt(rec, rank) { return rec.baseDrain + rank; }

  function fitWeapon(ctx, weapon, chosen, exilusEntry, stances, formaBudget, umbraForma) {
    var slotPols = (weapon.Polarities || []).slice(0, 8);
    while (slotPols.length < 8) slotPols.push(null);
    var exPol = weapon.ExilusPolarity;
    if (exPol === 'None' || exPol === '') exPol = null;

    // Stance: capacity-only pick — best polarity match at max rank.
    var stancePick = null, stanceBonus = 0;
    stances.forEach(function (s) {
      var mag = Math.abs(s.baseDrain) + s.maxRank;
      var bonus = (weapon.StancePolarity && s.polarity === weapon.StancePolarity) ? mag * 2 : mag;
      if (!stancePick || bonus > stanceBonus) { stancePick = s; stanceBonus = bonus; }
    });

    var all = chosen.slice();
    var exSlotIndex = -1;
    if (exilusEntry) {
      exSlotIndex = slotPols.length;
      slotPols.push(exPol);
      all.push(exilusEntry);
    }
    // Greedy assignment: largest drain first, prefer polarity match;
    // the exilus entry is pinned to the exilus slot.
    var order = all.slice().sort(function (a, b) { return drainAt(b.rec, b.rank) - drainAt(a.rec, a.rank); });
    var free = slotPols.map(function (_, i) { return i; });
    if (exilusEntry) free.splice(free.indexOf(exSlotIndex), 1);
    var assign = {};
    if (exilusEntry) assign[exilusEntry.rec.name] = exSlotIndex;
    order.forEach(function (c) {
      if (exilusEntry && c.rec.name === exilusEntry.rec.name) return;
      var idx = -1;
      for (var i = 0; i < free.length; i++) {
        if (polMatches(slotPols[free[i]], c.rec.polarity)) { idx = free[i]; break; }
      }
      if (idx < 0) idx = free[0];
      free.splice(free.indexOf(idx), 1);
      assign[c.rec.name] = idx;
    });
    function costWith(pols) {
      return all.reduce(function (s, c) {
        var d = drainAt(c.rec, c.rank);
        return s + (polMatches(pols[assign[c.rec.name]], c.rec.polarity) ? Math.ceil(d / 2) : d);
      }, 0);
    }
    var maxRankCap = weapon.MaxRank || 30;
    var budgetCap = (formaBudget === 'any' || formaBudget == null) ? Infinity : formaBudget;
    var attempts = [];
    var prevRankCap = -1;
    for (var over = 0; over <= 5; over++) {
      var rankCap = Math.min(maxRankCap, 30 + 2 * over);
      if (over > 0 && rankCap <= prevRankCap) break;
      prevRankCap = rankCap;
      var capMax = rankCap * 2 + stanceBonus;
      var remaining = budgetCap - over;
      if (remaining < 0) continue;
      var pols = slotPols.slice();
      var cost = costWith(pols);
      var plan = [];
      var regularUsed = 0;
      while (cost > capMax && regularUsed < remaining) {
        var best = null;
        all.forEach(function (c) {
          var slot = assign[c.rec.name];
          if (polMatches(pols[slot], c.rec.polarity)) return;
          if (c.rec.polarity === 'Umbra' || !c.rec.polarity) return;
          var d = drainAt(c.rec, c.rank);
          var saving = d - Math.ceil(d / 2);
          if (saving > 0 && (!best || saving > best.saving)) best = { slot: slot, polarity: c.rec.polarity, saving: saving };
        });
        if (!best) break;
        pols[best.slot] = best.polarity;
        plan.push({ slot: best.slot, polarity: best.polarity });
        regularUsed++;
        cost = costWith(pols);
      }
      var umbraBudget = umbraForma || 0;
      var umbraUsedCount = 0;
      while (cost > capMax && umbraUsedCount < umbraBudget) {
        var ubest = null;
        all.forEach(function (c) {
          if (c.rec.polarity !== 'Umbra') return;
          var slot = assign[c.rec.name];
          if (pols[slot] === 'Umbra') return;
          var d = drainAt(c.rec, c.rank);
          var saving = d - Math.ceil(d / 2);
          if (saving > 0 && (!ubest || saving > ubest.saving)) ubest = { slot: slot, saving: saving };
        });
        if (!ubest) break;
        pols[ubest.slot] = 'Umbra';
        plan.push({ slot: ubest.slot, polarity: 'Umbra', umbra: true });
        umbraUsedCount++;
        cost = costWith(pols);
      }
      attempts.push({
        overRankForma: over, capacityMax: capMax, capacityUsed: cost,
        formaUsed: regularUsed, umbraFormaUsed: umbraUsedCount,
        formaPlan: plan, valid: cost <= capMax,
        totalForma: over + regularUsed + umbraUsedCount
      });
      if (rankCap >= maxRankCap) break;
    }
    var valid = attempts.filter(function (a) { return a.valid; });
    var pick;
    if (valid.length) {
      pick = valid.slice().sort(function (a, b) {
        return (a.totalForma - b.totalForma) || (a.overRankForma - b.overRankForma);
      })[0];
    } else {
      pick = attempts.slice().sort(function (a, b) {
        return ((a.capacityUsed - a.capacityMax) - (b.capacityUsed - b.capacityMax)) ||
               (a.totalForma - b.totalForma);
      })[0];
    }
    pick.stance = stancePick ? stancePick.name : null;
    pick.stanceBonus = stanceBonus;
    return pick;
  }

  // ---- solver ------------------------------------------------------------------
  function achievedOf(fwd) {
    return {
      totalDamagePerShot: fwd.damagePerShot,
      totalDamage: fwd.totalDamage,
      critChance: fwd.critChance,
      critMultiplier: fwd.critMultiplier,
      statusChance: fwd.statusChance,
      fireRate: fwd.fireRate,
      multishot: fwd.multishot,
      magazine: fwd.magazine,
      reload: fwd.reload,
      punchThrough: fwd.punchThrough,
      factionMultiplier: fwd.factionMultiplier,
      factionAdjustedDamage: fwd.factionAdjustedDamage
    };
  }

  function solve(input, data) {
    var ctx = buildContext(data);
    var weapon = ctx.weapons[input.weaponName];
    if (!weapon) throw new Error('Unknown weapon: ' + input.weaponName);
    var pool = poolFor(ctx, weapon);
    if (!pool.slotSupported) {
      throw new Error('Weapon slot not supported by the weapon solver: ' + weapon.Slot +
                     ' (' + input.weaponName + ')');
    }
    var routesIn = input.routes || {};
    var routes = {
      mods: routesIn.mods !== false,
      exilus: !!routesIn.exilus,
      conditional: !!routesIn.conditional,
      stance: routesIn.stance !== false,
      arcanes: routesIn.arcanes !== false
    };
    var targets = input.targets || {};
    var targetedStats = Object.keys(targets).filter(function (s) {
      return targets[s] && targets[s].mode !== 'dontcare' && typeof targets[s].value === 'number';
    });
    function lowerBetter(stat) {
      var t = targets[stat];
      if (t && typeof t.lowerBetter === 'boolean') return t.lowerBetter;
      return !!DEFAULT_LOWER_BETTER[stat];
    }
    var fwdOpts = {
      conditional: routes.conditional,
      progenitor: input.progenitor || null,
      arcaneEffects: input.arcaneEffects || null
    };
    var baseFwd = forwardCalc(ctx, weapon, input.attackIndex, [], fwdOpts);
    var baseAch = achievedOf(baseFwd);

    // Analytic per-effect delta estimates for rank bracketing.
    var atk = (weapon.Attacks || [])[baseFwd.attackIndex] || {};
    var baseTotal = 0;
    Object.keys(atk.Damage || {}).forEach(function (k) { baseTotal += atk.Damage[k] || 0; });
    var effBaseTotal = baseTotal;
    if (fwdOpts.progenitor && weapon.IsLichWeapon) {
      effBaseTotal += baseTotal * (fwdOpts.progenitor.percent || 0) / 100;
    }
    var ipsBase = { Impact: (atk.Damage || {}).Impact || 0, Puncture: (atk.Damage || {}).Puncture || 0, Slash: (atk.Damage || {}).Slash || 0 };
    if (fwdOpts.progenitor && weapon.IsLichWeapon && IPS.indexOf(fwdOpts.progenitor.element) >= 0) {
      ipsBase[fwdOpts.progenitor.element] += baseTotal * (fwdOpts.progenitor.percent || 0) / 100;
    }
    function effectDelta(eff, rank, stat) {
      var cv = eff.valuePerRank * (rank + 1);
      switch (eff.kind) {
        case 'damagePct':
          return stat === 'totalDamagePerShot' ? baseAch.totalDamage * baseAch.multishot * cv / 100 : 0;
        case 'typedAdd':
          if (stat !== 'totalDamagePerShot') return 0;
          return (IPS.indexOf(eff.element) >= 0 ? ipsBase[eff.element] : effBaseTotal) * cv / 100 * baseAch.multishot;
        case 'convert':
          return 0; // distribution shaping, not a direct stat delta
        case 'critPct': return stat === 'critChance' ? baseAch.critChance * cv / 100 : 0;
        case 'critDmgPct': return stat === 'critMultiplier' ? (atk.CritMultiplier || 1) * cv / 100 : 0;
        case 'statusPct': return stat === 'statusChance' ? baseAch.statusChance * cv / 100 : 0;
        case 'statusFlat': return stat === 'statusChance' ? cv : 0;
        case 'fireRatePct': return stat === 'fireRate' ? baseAch.fireRate * cv / 100 : 0;
        case 'multishotPct':
          if (stat === 'multishot') return baseAch.multishot * cv / 100;
          if (stat === 'totalDamagePerShot') return baseAch.totalDamage * baseAch.multishot * cv / 100;
          return 0;
        case 'magPct': return stat === 'magazine' ? (weapon.Magazine || 0) * cv / 100 : 0;
        case 'magFlat': return stat === 'magazine' ? cv : 0;
        case 'reloadPct':
          if (stat !== 'reload' || weapon.Reload == null) return 0;
          return -(weapon.Reload - weapon.Reload / Math.max(0.05, 1 + cv / 100));
        case 'punchFlat': return stat === 'punchThrough' ? cv : 0;
        case 'faction':
          return stat === 'totalDamagePerShot'
            ? baseAch.totalDamage * baseAch.multishot * ((1 + (eff.maxValue - 1) * (rank + 1) / ((eff.maxRank || 0) + 1)) - 1) : 0;
        default: return 0;
      }
    }
    function candidateRanks(rec) {
      var set = {};
      set[rec.maxRank] = true;
      rec.effects.forEach(function (eff) {
        if (eff.conditional && !routes.conditional) return;
        targetedStats.forEach(function (stat) {
          var gap = targets[stat].value - (baseAch[stat] || 0);
          if (!gap) return;
          for (var r = 0; r <= rec.maxRank; r++) {
            var d = effectDelta(eff, r, stat);
            if (Math.sign(d) === Math.sign(gap) && Math.abs(d) >= Math.abs(gap)) {
              set[r] = true; if (r > 0) set[r - 1] = true; break;
            }
            if (Math.sign(d) === Math.sign(gap) && Math.abs(d) >= Math.abs(gap) / 2 &&
                Math.abs(effectDelta(eff, Math.max(0, r - 1), stat)) < Math.abs(gap) / 2) {
              set[r] = true;
            }
          }
        });
      });
      return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }

    var candMods = [];
    if (routes.mods) {
      pool.mods.forEach(function (rec) {
        var touches = rec.effects.some(function (eff) {
          if (eff.conditional && !routes.conditional) return false;
          return targetedStats.some(function (stat) {
            return Math.abs(effectDelta(eff, rec.maxRank, stat)) > 1e-12;
          });
        });
        if (touches) candMods.push({ rec: rec, ranks: candidateRanks(rec) });
      });
    }

    // Arcane candidates (one slot): pool entries whose Type fits this
    // weapon, converted to forward effects, kept when a usable effect
    // touches a targeted stat. Skipped entirely when the caller
    // injected anonymous arcaneEffects (those apply as-is).
    var KIND_STATS = {
      damagePct: ['totalDamagePerShot'], typedAdd: ['totalDamagePerShot'],
      faction: ['totalDamagePerShot'], critPct: ['critChance'],
      critDmgPct: ['critMultiplier'], statusPct: ['statusChance'],
      statusFlat: ['statusChance'], fireRatePct: ['fireRate'],
      multishotPct: ['multishot', 'totalDamagePerShot'],
      magPct: ['magazine'], magFlat: ['magazine'],
      reloadPct: ['reload'], punchFlat: ['punchThrough']
    };
    var candArcanes = [];
    var arcaneByName = {};
    if (routes.arcanes && !input.arcaneEffects) {
      ctx.arcanePool.forEach(function (entry) {
        if (!arcaneTypeMatches(entry, weapon)) return;
        var effs = arcaneEffectsForEntry(entry);
        var touches = effs.some(function (eff) {
          if (eff.conditional && !routes.conditional) return false;
          return (KIND_STATS[eff.kind] || []).some(function (s) {
            return targetedStats.indexOf(s) >= 0;
          });
        });
        if (touches) {
          candArcanes.push(entry.name);
          arcaneByName[entry.name] = effs;
        }
      });
    }

    function scoreState(ach, fit, state) {
      var shortfall = 0, closestDist = 0;
      targetedStats.forEach(function (stat) {
        var t = targets[stat];
        var a = ach[stat];
        if (a == null) { if (t.mode === 'atleast') shortfall += 1; return; }
        var denom = Math.max(1, Math.abs(t.value));
        if (t.mode === 'atleast') {
          if (lowerBetter(stat)) { if (a > t.value) shortfall += (a - t.value) / denom; }
          else if (a < t.value) shortfall += (t.value - a) / denom;
        } else if (t.mode === 'closest') {
          closestDist += Math.abs(a - t.value) / denom;
        }
      });
      var pieces = state.placed.length + (state.exilusMod ? 1 : 0) +
        (state.arcane ? 1 : 0);
      var tertiary = pieces * 0.01 + (fit.formaUsed + fit.overRankForma) * 0.01;
      var score = shortfall * 10000 + closestDist * 100 + tertiary + (fit.valid ? 0 : 20000);
      return { score: score, shortfall: shortfall, closestDist: closestDist };
    }

    function emptyState() { return { placed: [], exilusMod: null, arcane: null }; }
    function signature(s) {
      return s.placed.map(function (p) { return p.rec.name + '@' + p.rank; }).join(',') +
        '|' + (s.exilusMod ? s.exilusMod.rec.name + '@' + s.exilusMod.rank : '') +
        '|' + (s.arcane || '');
    }
    function modCountOf(s) { return s.placed.length + (s.exilusMod ? 1 : 0); }
    function canPlace(state, rec) {
      var names = state.placed.map(function (p) { return p.rec.name; });
      if (state.exilusMod) names.push(state.exilusMod.rec.name);
      if (names.indexOf(rec.name) >= 0) return false;
      return !names.some(function (u) {
        return (rec.incompatible || []).indexOf(u) >= 0 ||
               ((ctx.modByName[u].incompatible || []).indexOf(rec.name) >= 0);
      });
    }
    function evaluate(state, scoreFn) {
      var placedAll = state.placed.slice();
      if (state.exilusMod) {
        // Exilus slot is the last slot: its effects (incl. any elemental
        // add's sequence position) come after the normal slots.
        placedAll.push({ rec: state.exilusMod.rec, rank: state.exilusMod.rank });
      }
      var opts = fwdOpts;
      if (state.arcane) {
        opts = Object.assign({}, fwdOpts, {
          arcaneEffects: arcaneByName[state.arcane] || []
        });
      }
      var fwd = forwardCalc(ctx, weapon, input.attackIndex, placedAll, opts);
      var fit = fitWeapon(ctx, weapon, state.placed,
        state.exilusMod ? { rec: state.exilusMod.rec, rank: state.exilusMod.rank } : null,
        routes.stance ? pool.stances : [], input.formaBudget, input.umbraForma || 0);
      var ach = achievedOf(fwd);
      var sc = (scoreFn || scoreState)(ach, fit, state);
      return { state: state, fwd: fwd, achieved: ach, fit: fit, score: sc.score,
               shortfall: sc.shortfall, closestDist: sc.closestDist || 0 };
    }
    function expand(state) {
      var out = [];
      if (state.placed.length < 8) {
        candMods.forEach(function (c) {
          if (!canPlace(state, c.rec)) return;
          c.ranks.forEach(function (r) {
            var ns = { placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: state.arcane };
            ns.placed.push({ rec: c.rec, rank: r });
            out.push(ns);
          });
        });
      }
      if (routes.exilus && !state.exilusMod) {
        candMods.forEach(function (c) {
          if (!c.rec.exilus) return;
          if (!canPlace(state, c.rec)) return;
          c.ranks.forEach(function (r) {
            var ns = { placed: state.placed.slice(), exilusMod: { rec: c.rec, rank: r }, arcane: state.arcane };
            out.push(ns);
          });
        });
      }
      // Arcane slot: one pick from the type-matched pool candidates.
      if (!state.arcane) {
        candArcanes.forEach(function (name) {
          out.push({ placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: name });
        });
      }
      return out;
    }

    var BEAM = 60, LANE = 10;
    function selectBeam(evals) {
      var sorted = evals.slice().sort(function (a, b) { return a.score - b.score; });
      var picked = {}, out = [];
      var lanes = {};
      sorted.forEach(function (ev) {
        var k = modCountOf(ev.state);
        (lanes[k] = lanes[k] || []).push(ev);
      });
      Object.keys(lanes).forEach(function (k) {
        lanes[k].slice(0, LANE).forEach(function (ev) {
          var sig = signature(ev.state);
          if (!picked[sig]) { picked[sig] = true; out.push(ev); }
        });
      });
      for (var i = 0; i < sorted.length && out.length < BEAM; i++) {
        var sig2 = signature(sorted[i].state);
        if (!picked[sig2]) { picked[sig2] = true; out.push(sorted[i]); }
      }
      return out.sort(function (a, b) { return a.score - b.score; });
    }

    // Beam search, parameterised by scoring function so the cheapest
    // pass (Stage S3, parity with solver.js) can rerun it with
    // cost-dominant weights. acceptFn (optional) restricts which valid
    // states may be returned as the run's best.
    function runSearch(scoreFn, acceptFn) {
      var beam = [evaluate(emptyState(), scoreFn)];
      var bestValidEver = null;
      beam.forEach(function (ev) {
        if (ev.fit.valid && (!acceptFn || acceptFn(ev))) bestValidEver = ev;
      });
      for (var round = 0; round < 18; round++) {
        var seen = {}, next = [], newCount = 0;
        beam.forEach(function (ev) { seen[signature(ev.state)] = true; next.push(ev); });
        beam.forEach(function (ev) {
          expand(ev.state).forEach(function (ns) {
            var sig = signature(ns);
            if (seen[sig]) return;
            seen[sig] = true;
            newCount++;
            next.push(evaluate(ns, scoreFn));
          });
        });
        next.forEach(function (ev) {
          if (ev.fit.valid && (!acceptFn || acceptFn(ev)) &&
              (!bestValidEver || ev.score < bestValidEver.score)) bestValidEver = ev;
        });
        beam = selectBeam(next);
        if (newCount === 0) break;
      }
      if (bestValidEver) return { ev: bestValidEver, fellBack: false };
      var finals = beam.slice().sort(function (a, b) { return a.score - b.score; });
      return { ev: finals[0], fellBack: true };
    }

    var mainRun = runSearch(null, null);
    var chosenEv = mainRun.ev;

    // Cheapest variant: same search, cost weights dominant (fewest
    // mods, then fewest Forma including over-rank Forma), restricted
    // to states meeting the main result (shortfall no worse, Closest
    // within 0.05). Null when identical to the main result.
    var cheapestEv = null;
    if (targetedStats.length) {
      var cheapScore = function (ach, fit, state) {
        var base = scoreState(ach, fit, state);
        var cost = modCountOf(state) * 10000 +
          (fit.formaUsed + fit.overRankForma) * 100 +
          (fit.umbraFormaUsed || 0) * 100 + (state.arcane ? 1 : 0);
        return {
          score: base.shortfall * 1e9 + base.closestDist * 1e5 + cost +
                 (fit.valid ? 0 : 1e10),
          shortfall: base.shortfall, closestDist: base.closestDist
        };
      };
      var mainShortfall = chosenEv.shortfall;
      var mainClosest = chosenEv.closestDist || 0;
      var cheapRun = runSearch(cheapScore, function (ev) {
        return ev.shortfall <= mainShortfall + 1e-9 &&
               ev.closestDist <= mainClosest + 0.05;
      });
      if (!cheapRun.fellBack &&
          signature(cheapRun.ev.state) !== signature(chosenEv.state)) {
        cheapestEv = cheapRun.ev;
      }
    }

    function buildResult(evRes) {
    var st = evRes.state;
    var notes = [];
    notes.push('Capacity assumes an Orokin Catalyst is installed (rank cap x 2).');
    if (weapon.IsLichWeapon && !input.progenitor) {
      notes.push('Lich-family weapon: no progenitor bonus applied. Pass progenitor {element, percent} (your copy\'s 25-60% bonus) for correct base stats.');
    }
    if ((weapon.MaxRank || 30) > 30 && evRes.fit.overRankForma > 0) {
      notes.push('Over-rank: ' + evRes.fit.overRankForma + ' Forma raise the rank cap to ' +
                 Math.min(weapon.MaxRank || 30, 30 + 2 * evRes.fit.overRankForma) + '.');
    }

    var achieved = {};
    Object.keys(evRes.achieved).forEach(function (k) {
      var v = evRes.achieved[k];
      achieved[k] = (typeof v === 'number') ? round2(v) : v;
    });
    var unmet = [];
    targetedStats.forEach(function (stat) {
      var t = targets[stat];
      var a = evRes.achieved[stat];
      if (t.mode !== 'atleast') return;
      if (a == null || (lowerBetter(stat) ? a > t.value + 1e-9 : a < t.value - 1e-9)) {
        unmet.push({ stat: stat, target: t.value, achieved: (a == null ? null : round2(a)) });
      }
    });
    unmet.forEach(function (u) {
      var hints = [];
      if (!routes.conditional) hints.push('conditional buffs');
      if (!routes.exilus) hints.push('the exilus slot');
      if (u.achieved == null) {
        notes.push('Target ' + u.stat + ' ' + u.target + ' cannot be evaluated: this weapon/attack has no such stat.');
      } else if (hints.length) {
        notes.push('Target ' + u.stat + ' ' + u.target + ' was not reached (best ' + u.achieved + '). Disabled routes that could add more: ' + hints.join(', ') + '.');
      } else {
        notes.push('Target ' + u.stat + ' ' + u.target + ' was not reached; ' + u.achieved + ' is the best found with all enabled routes.');
      }
    });

    // Set accounting (pieces on this weapon + cross-gear support pieces).
    var counts = {};
    function bump(set, kind) {
      if (!set) return;
      counts[set] = counts[set] || { focus: 0, support: 0 };
      counts[set][kind] += 1;
    }
    st.placed.forEach(function (p) { bump(ctx.setOfMod[p.rec.name], 'focus'); });
    if (st.exilusMod) bump(ctx.setOfMod[st.exilusMod.rec.name], 'focus');
    if (input.supportSetPieces) {
      Object.keys(input.supportSetPieces).forEach(function (set) {
        var n = input.supportSetPieces[set] | 0;
        if (n > 0) { counts[set] = counts[set] || { focus: 0, support: 0 }; counts[set].support += n; }
      });
    }
    var setBonuses = [];
    Object.keys(counts).forEach(function (set) {
      var sb = ctx.setBonuses[set];
      var pieces = counts[set].focus + counts[set].support;
      setBonuses.push({
        set: set, pieces: pieces, focusPieces: counts[set].focus,
        supportPieces: counts[set].support,
        parseStatus: sb ? sb.parseStatus : 'unknown',
        perPiece: sb ? sb.perPiece : null,
        totalValue: (sb && sb.perPiece && sb.perPiece.length === 1 &&
                     typeof sb.perPiece[0].value === 'number')
          ? sb.perPiece[0].value * pieces : null,
        applied: false,
        sourceText: sb ? sb.sourceText : ''
      });
      if (pieces >= 2 && sb && sb.parseStatus !== 'parsed') {
        notes.push('Set bonus for ' + set + ' not modelled (prose effect)' +
                   (sb.sourceText ? ': "' + sb.sourceText + '"' : '') + '.');
      }
      if (set === 'Gladiator Set' && pieces >= 1) {
        notes.push('Gladiator Set bonus (+10% Critical Chance per Combo Multiplier per piece, ' +
                   pieces + ' piece' + (pieces > 1 ? 's' : '') + ') is not added to paper stats — the combo multiplier is not a paper stat.');
      }
    });
    setBonuses.sort(function (a, b) { return a.set < b.set ? -1 : 1; });

    // Ranking costs (Fusion page formula, see rankCostFor).
    var totalRankCost = { endo: 0, credits: 0 };
    var unknownCost = [];
    function costedMod(p, slot) {
      var rc = rankCostFor(p.rec, p.rank);
      if (rc) {
        totalRankCost.endo += rc.endo;
        totalRankCost.credits += rc.credits;
      } else {
        unknownCost.push(p.rec.name);
      }
      return { name: p.rec.name, rank: p.rank, slot: slot, rankCost: rc };
    }
    var costedMods = st.placed.map(function (p) { return costedMod(p, 'normal'); })
      .concat(st.exilusMod ? [costedMod(st.exilusMod, 'exilus')] : []);
    if (unknownCost.length) {
      notes.push('Ranking cost unknown for ' + unknownCost.join(', ') +
        ' (rarity outside the wiki Fusion page tables); totalRankCost ' +
        'excludes them.');
    }
    if (st.arcane) {
      notes.push('Arcane: ' + st.arcane + ' (conditional effects counted ' +
        'at full stacks — paper stats).');
    }

    return {
      achieved: achieved,
      forward: evRes.fwd,
      arrangement: {
        mods: costedMods,
        arcane: st.arcane || null,
        stance: evRes.fit.stance,
        formaUsed: evRes.fit.formaUsed,
        overRankForma: evRes.fit.overRankForma,
        umbraFormaUsed: evRes.fit.umbraFormaUsed || 0,
        formaPlan: evRes.fit.formaPlan,
        capacityUsed: evRes.fit.capacityUsed,
        capacityMax: evRes.fit.capacityMax
      },
      setBonuses: setBonuses,
      unmetTargets: unmet,
      totalRankCost: totalRankCost,
      notes: notes
    };
    }

    var result = buildResult(chosenEv);
    if (mainRun.fellBack) {
      result.notes.unshift('No arrangement within the Forma budget fits the mod capacity; showing the best-scoring arrangement, which exceeds capacity.');
    }
    result.cheapest = null;
    if (cheapestEv) {
      var ch = buildResult(cheapestEv);
      result.cheapest = {
        achieved: ch.achieved, arrangement: ch.arrangement,
        setBonuses: ch.setBonuses, unmetTargets: ch.unmetTargets,
        totalRankCost: ch.totalRankCost
      };
    }
    return result;
  }

  var WeaponSolver = {
    solve: solve,
    forward: forward,
    _internal: {
      buildContext: buildContext,
      poolFor: poolFor,
      forwardCalc: forwardCalc,
      fitWeapon: fitWeapon,
      classifyEffect: classifyEffect,
      stanceTypeFor: stanceTypeFor,
      arcaneEffectsForEntry: arcaneEffectsForEntry,
      arcaneTypeMatches: arcaneTypeMatches,
      rankCostFor: rankCostFor,
      COMBO: COMBO
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WeaponSolver;
  }
  if (typeof window !== 'undefined') {
    window.WeaponSolver = WeaponSolver;
  }
})();
