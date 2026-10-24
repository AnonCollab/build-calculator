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
 *
 * v1.1 (engine stage E1):
 *  - Maximize mode + fill phase (same discipline as solver.js):
 *    hard targets solve first; leftover slots/capacity/Forma then
 *    raise Maximize stats lexicographically by priority without
 *    worsening any target outcome. result.cheapest is REDEFINED as
 *    the no-fill solve when the fill changed the build (the S3
 *    cost-dominant re-run semantic is gone).
 *  - Damage-type targets: dmg:<Type> for the 13 damage types + Void,
 *    all four modes; achieved reports every type's per-shot amount.
 *  - Ordered slot list: arrangement.slots derives from the fit's
 *    assignment; the final build is re-expressed in physical slot
 *    order and the elemental mods' relative order is optimised over
 *    the elemental-occupied slots (cap 120 permutations) against
 *    the full target set — that order drives combining.
 *  - Locks: input.lockedMods / input.lockedArcanes (stat-less mods
 *    via input.extraModRecords), seeded before the search; the only
 *    permitted change is the reported capacity rank trim.
 *  - Deficit lanes: up to 2 extra beam states per at-least stat
 *    (6 per round), the closest-from-below states for that stat.
 *  - evaluateWeapon(data, weaponName, attackIndex, orderedPieces,
 *    progenitor): forward evaluator for the board editor, sharing
 *    this file's forwardCalc + fitWeapon.
 *
 * v1.2 (engine stage F1, parity with solver.js):
 *  - Excludes: input.excludedMods / input.excludedArcanes ban pieces
 *    from every candidate pool (search AND fill); a piece that is
 *    both locked and excluded is a hard Error.
 *  - Cross-gear planning: with input.crossGear present, the finished
 *    build gains result.crossGearPlan (specific mods on specific
 *    support gear completing reachable set bonuses) and planned
 *    pieces count in setBonuses totals immediately.
 *    input.supportSetPieces remains accepted (legacy counts).
 *  - Breakdowns: results and evaluateWeapon return `breakdown` —
 *    for totalDamagePerShot and every dmg:<Type>, a Base entry then
 *    one entry per occupied slot in slot order (arcane last), whose
 *    final cumulative equals the reported achieved value (round2).
 *    Each entry also carries `delta`, its own increase over the
 *    previous entry (Base's delta is its own value).
 *
 * v1.4 (engine stage, parity with solver.js):
 *  - Restricted pieces: pool records carry `restrictedTo` (the
 *    pipeline turns item-named Types into category records
 *    restricted to one item). poolFor admits a restricted record
 *    ONLY for its exact item (weapon.Name match). Weapon FAMILY
 *    variants (a Sobek mod on a Kuva Sobek) are NOT admitted —
 *    family membership is not an eligibility rule in the source
 *    data; noted limitation, not a guess. A lock naming a mod
 *    restricted to another weapon is a hard Error, the same class
 *    as a wrong-type lock.
 *  - Hybrid intent: input.intent 'hybrid' + input.hybridAllowance
 *    (1 | 2, default 1; input.burstAllowance alias) — upkeep
 *    discipline with a burst allowance over SOLVER-CHOSEN burst
 *    pieces, enforced in expand() and the fill acceptance check;
 *    locked burst pieces do not consume it (Q1). result.hybridBurst
 *    names the solver-chosen burst pieces; sustained semantics
 *    unchanged. Window / upkeep / unset byte-identical to v1.3.
 *
 * v1.5.2 (forma pool parity with solver.js):
 *  - fitWeapon counts from the polarity POOL (innate polarities of
 *    the 8 regular slots + the Exilus slot, plus one per Forma)
 *    instead of a greedy slot assignment — the greedy version let a
 *    non-matching mod squat on an innate slot and charged a Forma
 *    for the loss (Phantasma golden in tests/weapon.test.js).
 *    Wiki-verified scope (BUILD_LOG "v1.5.2 verification"): regular
 *    + unlocked Exilus slots swap; the STANCE slot never does (fixed
 *    StancePolarity, Stance Forma is a separate item); slot-data
 *    'Universal' means NO innate polarity, while a user-chosen
 *    'Universal' is the Omni wildcard (halves any mod except Umbra).
 *  - evaluateWeapon gains the GIVEN-polarity mode (a slot entry
 *    carrying `polarity` switches scoring, mirroring evaluateFrame):
 *    the board is priced as-is and the result gains `plan` in fit
 *    mode for the editor's Re-Forma.
 *
 * v1.6.0 (#14 — polarity-mismatch drain penalty):
 *  - A mod in a slot of a DIFFERENT polarity costs ceil(drain x
 *    1.25) (wiki "Polarity"), priced everywhere through the shared
 *    drainInSlotW helper: fitWeapon's pool counting (unit
 *    accounting — remaining innate units land on empty slots and
 *    polarity-less leftovers first, so only the smallest polarized
 *    leftovers that cannot avoid a unit pay it), the elemental
 *    permutation pass, givenFitWeapon, and the board slot list,
 *    whose per-slot drains still sum exactly to the counted
 *    capacityUsed. A 'Universal' slot is NOT a mismatch (and does
 *    not halve Umbra); slot-data 'Universal' is no polarity at
 *    all — never a match, never a mismatch.
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

  // v1.3: is this piece burst-class per the Stage 1 classification
  // (data.conditionalClasses, keyed by piece name)? Unclassified and
  // non-conditional pieces are never burst.
  function isBurstPiece(ctx, name) {
    var r = name ? ctx.condClasses[name] : null;
    return !!(r && r.class === 'burst');
  }

  // v1.4 hybrid allowance (parity with solver.js): input.
  // hybridAllowance (1 | 2, default 1); input.burstAllowance alias.
  function burstAllowanceOf(input) {
    var a = (typeof input.hybridAllowance === 'number') ? input.hybridAllowance
      : (typeof input.burstAllowance === 'number') ? input.burstAllowance : 1;
    return a === 2 ? 2 : 1;
  }

  function buildContext(data) {
    var ctx = {};
    // v1.3 conditional-piece classes (Stage 1). Optional bundle
    // key — absent means no intent pruning anywhere.
    ctx.condClasses = (data && data.conditionalClasses) || {};
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
        exilus: !!m.exilus, restrictedTo: m.restrictedTo || null, // v1.4
        effects: effs
      });
    });
    ctx.modByName = {};
    ctx.modPool.forEach(function (m) { ctx.modByName[m.name] = m; });

    // Full arcane pool (S2): raw entries from
    // data/derived/arcane_effects_full.json; conversion to forward
    // effects happens per entry in arcaneEffectsForEntry.
    ctx.arcanePool = (data.arcaneEffects && data.arcaneEffects.arcanes) || [];

    // name -> {type, set} for every derived mod (v1.2 cross-gear
    // planning reads member types, incl. mods the pool dropped).
    ctx.derivedByName = {};
    mods.forEach(function (m) {
      ctx.derivedByName[m.name] = { type: m.type || null, set: m.set || null };
    });

    ctx.setBonuses = {};
    var sbData = (data.setBonuses && data.setBonuses.sets) || {};
    Object.keys(sbData).forEach(function (name) {
      var s = sbData[name] || {};
      ctx.setBonuses[name] = {
        perPiece: Array.isArray(s.perPiece) ? s.perPiece : null,
        enhanceByMod: (s.enhanceByMod && typeof s.enhanceByMod === 'object')
          ? s.enhanceByMod : null,
        parseStatus: s.parseStatus || 'prose',
        sourceText: s.sourceText || '',
        numUpgradesInSet: s.numUpgradesInSet || null,
        members: Array.isArray(s.members) ? s.members.slice() : []
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
    if (!types) return { mods: [], stances: [], types: [], slotSupported: false };
    var mods = ctx.modPool.filter(function (m) {
      // v1.4: a restricted record belongs to its exact item only
      // (post-transform its Type is the category, so the type legs
      // below would otherwise admit it for every weapon in the
      // category — the Deadly Sequence-on-Braton bug).
      if (m.restrictedTo && m.restrictedTo !== weapon.Name) return false;
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
    return { mods: mods, stances: stances, types: types, slotSupported: true };
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
    // Umbral/Sacrificial enhancement (v1.6.2): the dataset's
    // per-mod table (enhanceByMod, keyed by piece count) scales a
    // set mod's own effects when enough pieces of its set are
    // placed on THIS weapon. The faction kind scales its computed
    // per-rank multiplier as a whole.
    var placedSetCounts = {};
    placed.forEach(function (p) {
      if (p.rec.set) placedSetCounts[p.rec.set] = (placedSetCounts[p.rec.set] || 0) + 1;
    });
    function applyMod(rec, rank) {
      var enhScale = 1;
      if (rec.set) {
        var sbw = ctx.setBonuses[rec.set];
        var tbl = sbw && sbw.enhanceByMod && sbw.enhanceByMod[rec.name];
        var pct = tbl ? tbl[placedSetCounts[rec.set] || 0] : null;
        if (typeof pct === 'number') enhScale = 1 + pct / 100;
      }
      rec.effects.forEach(function (eff) {
        if (eff.conditional && !opts.conditional) return;
        if (eff.kind === 'faction') {
          var frac = (rank + 1) / ((eff.maxRank || 0) + 1);
          applyEffect(eff, (1 + (eff.maxValue - 1) * frac) * enhScale);
        } else {
          applyEffect(eff, eff.valuePerRank * (rank + 1) * enhScale);
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
  // polMatches(slotPol, modPol): a slot polarity halves a mod's drain
  // on an exact match, or when the slot carries the Omni-Forma
  // 'Universal' polarity — which per the wiki ("Omni Forma") halves
  // any mod EXCLUDING Umbra-polarity ones (an Umbral mod there is not
  // a mismatch either: full drain, no penalty). NOTE: 'Universal' in
  // raw weapon SLOT data is a different thing — a sentinel for "no
  // innate polarity" (Dual Heat Swords' stance per "Stance Forma",
  // Haalvu's exilus) — slotPolOf normalizes it away before any fit
  // sees it; only a user-chosen board polarity means the wildcard.
  function polMatches(slotPol, modPol) {
    return !!slotPol && !!modPol &&
      (slotPol === modPol || (slotPol === 'Universal' && modPol !== 'Umbra'));
  }
  function slotPolOf(p) {
    return (p && p !== 'None' && p !== 'Universal') ? p : null;
  }
  function drainAt(rec, rank) { return rec.baseDrain + rank; }

  // v1.6.0 (#14): the game's polarity-mismatch drain penalty (wiki
  // "Polarity"): a mod in a slot of a DIFFERENT polarity costs
  // ceil(drain * 1.25). polMatches above is the match rule (a
  // user-chosen 'Universal' slot matches any mod except Umbra —
  // and an Umbra mod there is NOT a mismatch either: full drain,
  // no penalty). Slot-data 'Universal'/'None' read as NO polarity
  // via slotPolOf — never a match, never a mismatch. This helper
  // prices givenFitWeapon, the permutation pass, and the board
  // slot list; fitWeapon's counting applies the same rule through
  // its unit accounting (see there).
  function drainInSlotW(d, slotPol, modPol) {
    if (d <= 0) return d;
    var mp = (modPol && modPol !== 'None') ? modPol : null;
    if (!mp) return d;
    if (polMatches(slotPol, mp)) return Math.ceil(d / 2);
    if (slotPolOf(slotPol)) return Math.ceil(d * 1.25);
    return d;
  }

  // Stance: capacity-only pick — best polarity match at max rank.
  // The stance slot NEVER joins the polarity pool (v1.5.2 wiki
  // verification): its polarity cannot be swapped with other slots
  // (U38.5.3/U38.5.2) and regular Forma cannot target it — Stance
  // Forma is a separate item, not modelled. Fixed StancePolarity,
  // bonus = magnitude (|baseDrain| + rank), doubled on a match.
  function stancePickFor(weapon, stances) {
    var pick = null, bonus = 0;
    (stances || []).forEach(function (s) {
      var mag = Math.abs(s.baseDrain) + s.maxRank;
      var b = (weapon.StancePolarity && s.polarity === weapon.StancePolarity) ? mag * 2 : mag;
      if (!pick || b > bonus) { pick = s; bonus = b; }
    });
    return { name: pick ? pick.name : null, bonus: bonus };
  }

  // v1.5.2: the fit is counted from the polarity POOL, mirroring
  // solver.js fitCapacity — the slot-greedy assignment it replaces
  // let a non-matching mod squat on an innate-polarity slot (Primed
  // Ravage on the Phantasma's Naramon slot) and charged a Forma for
  // the loss. Wiki-verified scope (BUILD_LOG "v1.5.2 verification"):
  // once an item has been polarized, existing polarities rearrange
  // freely among the regular slots AND the (unlocked) Exilus slot, so
  // a build owns a pool = those slots' innate polarities + one
  // polarity per Forma spent. Counting: (1) free matches — per
  // polarity, the biggest-drain mods of that polarity up to the
  // innate count (the exilus mod competes in the same pool; only its
  // SLOT is pinned); (2) Forma spend over the remaining unmatched
  // mods, biggest saving first, until capacity fits or the budget
  // runs out; Umbra Forma is the separate budget for Umbra-polarity
  // mods, as before. The over-rank attempt space (0..5 Forma raising
  // the rank cap toward MaxRank) and the attempt selection are
  // unchanged — the pool count runs INSIDE each attempt. Slot
  // PLACEMENT is derived after the pick (assign/pols/formaPlan keep
  // their v1.1 shapes; the fit also returns the matched sets for the
  // editor's Re-Forma).
  // v1.9.0 (#25): Starting Pool helpers — the frame solver carries
  // its own copies (the established cross-solver duplication
  // pattern). The pool is the multiset of polarities already
  // invested in the item, over the swappable slots (regular slots
  // + the Exilus slot; the Stance slot NEVER joins — Update
  // 38.5.2 — and stancePickFor's fixed polarity stays untouched).
  var POOL_VOCAB = {
    Madurai: 1, Naramon: 1, Vazarin: 1, Zenurik: 1,
    Penjaga: 1, Unairu: 1, Umbra: 1, Universal: 1
  };
  var POOL_VOCAB_ORDER = ['Madurai', 'Naramon', 'Vazarin', 'Zenurik',
    'Penjaga', 'Unairu', 'Umbra', 'Universal'];
  function poolCountsOf(poolArr, innateCounts) {
    var counts = {};
    if (Array.isArray(poolArr)) {
      poolArr.forEach(function (p) {
        if (POOL_VOCAB[p]) counts[p] = (counts[p] || 0) + 1;
      });
      return counts;
    }
    Object.keys(innateCounts).forEach(function (p) {
      counts[p] = innateCounts[p];
    });
    return counts;
  }
  // The item's current arrangement derived from a pool: keep every
  // innate seat whose polarity the pool still owns, then seat the
  // remaining units (vocabulary order) on the remaining seats in
  // ascending order (the Exilus seat, last in the array, fills
  // last). Seeded pool ⇒ arrangement == innate, exactly.
  function arrangePool(innateArr, poolCounts) {
    var left = {};
    Object.keys(poolCounts).forEach(function (p) { left[p] = poolCounts[p]; });
    var out = innateArr.map(function (p) {
      if (p && left[p] > 0) { left[p]--; return p; }
      return null;
    });
    POOL_VOCAB_ORDER.forEach(function (p) {
      for (var i = 0; i < out.length && left[p] > 0; i++) {
        if (out[i] === null) { out[i] = p; left[p]--; }
      }
    });
    return out;
  }
  // v1.9.0: rearrangement guidance from a fit's derived plan —
  // seats whose shown polarity differs from the item's current
  // arrangement (basePols) without any forma spent there are pure
  // rearrangement. Exact inverse pairs read as swaps ("X polarity
  // swapped for Y") or, when one side is unpolarized, as a move;
  // anything else is listed per seat. Granularity is honest: the
  // pool is a multiset, so guidance names polarities and seats
  // only where the derived plan itself pins them.
  function swapLinesFor(basePols, planPols, formaSeatSet, exilusIndex) {
    function seatLabel(i) {
      return i === exilusIndex ? 'the Exilus slot' : 'slot ' + (i + 1);
    }
    var diffs = [];
    for (var i = 0; i < planPols.length; i++) {
      if (formaSeatSet[i]) continue;
      var b = basePols[i] || null, p = planPols[i] || null;
      if (b !== p) diffs.push({ slot: i, from: b, to: p });
    }
    var lines = [], used = {};
    diffs.forEach(function (d) {
      if (used[d.slot]) return;
      var pair = null;
      diffs.forEach(function (e) {
        if (!pair && e.slot !== d.slot && !used[e.slot] &&
            e.from === d.to && e.to === d.from) pair = e;
      });
      if (!pair) return;
      used[d.slot] = used[pair.slot] = true;
      if (d.from && d.to) {
        lines.push(d.from + ' polarity swapped for ' + d.to +
          ' — rearrange the polarities you already have; no Forma needed.');
      } else {
        var pol = d.from || d.to;
        var fromSeat = d.from ? d.slot : pair.slot;
        var toSeat = d.from ? pair.slot : d.slot;
        lines.push(pol + ' polarity moved from ' + seatLabel(fromSeat) +
          ' to ' + seatLabel(toSeat) + ' — no Forma needed.');
      }
    });
    diffs.forEach(function (d) {
      if (used[d.slot]) return;
      used[d.slot] = true;
      lines.push('Slot ' + (d.slot + 1) + ' polarity: ' +
        (d.from || 'none') + ' → ' + (d.to || 'none') +
        ' (rearrangement of the polarities you already have).');
    });
    return lines;
  }

  function fitWeapon(ctx, weapon, chosen, exilusEntry, stances, formaBudget, umbraForma, poolOpts) {
    var slotPols = (Array.isArray(weapon.Polarities) ? weapon.Polarities : [])
      .slice(0, 8).map(slotPolOf);
    while (slotPols.length < 8) slotPols.push(null);
    var exPol = slotPolOf(weapon.ExilusPolarity);
    var sp = stancePickFor(weapon, stances);

    var all = chosen.slice();
    var exSlotIndex = -1;
    if (exilusEntry) {
      exSlotIndex = slotPols.length; // 8
      slotPols.push(exPol);
      all.push(exilusEntry);
    }
    // v1.9.0 (#25): the Starting Pool for this item and the current
    // arrangement derived from it. The innate counts cover the
    // materialized seats (the Exilus seat counts only when an
    // exilus entry is fielded, exactly as the fit has always
    // materialized it); a declared pool unit beyond the seats is
    // excess — usable by matches, never seated.
    var innateCounts = {};
    slotPols.forEach(function (p) {
      if (p) innateCounts[p] = (innateCounts[p] || 0) + 1;
    });
    var poolDeclared = !!(poolOpts && Array.isArray(poolOpts.pool));
    var poolCounts = poolCountsOf(poolDeclared ? poolOpts.pool : null,
      innateCounts);
    var basePols = arrangePool(slotPols, poolCounts);
    var formaAlreadyIn = 0;
    Object.keys(poolCounts).forEach(function (p) {
      formaAlreadyIn += Math.max(0, poolCounts[p] - (innateCounts[p] || 0));
    });
    var seatedUnits = 0;
    basePols.forEach(function (p) { if (p) seatedUnits++; });
    var excessSeed = {};
    Object.keys(poolCounts).forEach(function (p) {
      var seated = 0;
      basePols.forEach(function (q) { if (q === p) seated++; });
      excessSeed[p] = poolCounts[p] - seated;
    });
    function polOf(c) {
      var p = c.rec.polarity;
      return (p && p !== 'None') ? p : null;
    }
    function savingOf(c) {
      var d = drainAt(c.rec, c.rank);
      return d - Math.ceil(d / 2);
    }
    // Deterministic candidate order (fitCapacity's convention):
    // biggest saving, then biggest drain, then name.
    function bySaving(a, b) {
      return (savingOf(b) - savingOf(a)) ||
             (drainAt(b.rec, b.rank) - drainAt(a.rec, a.rank)) ||
             (a.rec.name < b.rec.name ? -1 : 1);
    }
    function byDrain(a, b) {
      return (drainAt(b.rec, b.rank) - drainAt(a.rec, a.rank)) ||
             (a.rec.name < b.rec.name ? -1 : 1);
    }

    var maxRankCap = weapon.MaxRank || 30;
    var budgetCap = (formaBudget === 'any' || formaBudget == null) ? Infinity : formaBudget;
    var attempts = [];
    var prevRankCap = -1;
    for (var over = 0; over <= 5; over++) {
      var rankCap = Math.min(maxRankCap, 30 + 2 * over);
      if (over > 0 && rankCap <= prevRankCap) break;
      prevRankCap = rankCap;
      var capMax = rankCap * 2 + sp.bonus;
      var remaining = budgetCap - over;
      if (remaining < 0) continue;
      var matched = {}, matchedFree = [], matchedForma = [], matchedUmbra = [];
      // v1.9.0: per-attempt pool-unit consumption (excess units
      // first, then seated units — the order that leaves the most
      // polarized seats for the leftover arrangement below).
      var excessLeft = {}, seatedLeft = {};
      Object.keys(poolCounts).forEach(function (p) {
        excessLeft[p] = excessSeed[p] || 0;
      });
      basePols.forEach(function (p) {
        if (p) seatedLeft[p] = (seatedLeft[p] || 0) + 1;
      });
      function consumeUnit(p) {
        if ((excessLeft[p] || 0) > 0) { excessLeft[p]--; return 'excess'; }
        if ((seatedLeft[p] || 0) > 0) { seatedLeft[p]--; return 'seated'; }
        return null;
      }
      function seatedLeftTotal() {
        var n = 0;
        Object.keys(seatedLeft).forEach(function (p) { n += seatedLeft[p]; });
        return n;
      }
      function poolUnitsLeft() {
        var out = {};
        Object.keys(poolCounts).forEach(function (p) {
          var n = (excessLeft[p] || 0) + (seatedLeft[p] || 0);
          if (n > 0) out[p] = n;
        });
        return out;
      }
      // v1.6.0 (#14): the PRICED cost of the current matched sets,
      // applying drainInSlotW's rule through unit accounting. The
      // pool's units are mobile (the swap model): after the
      // free matches consume theirs, the remaining units R must be
      // shown somewhere — on empty slots first, then on
      // polarity-less leftovers (never penalised), and only the
      // smallest polarized leftovers that still cannot avoid a
      // unit pay ceil(drain * 1.25) instead of drain. (A remaining
      // unit's polarity never equals a leftover mod's polarity —
      // every mod of that polarity was free-matched first — so
      // any unit a polarized leftover shows is a genuine
      // mismatch.) The Exilus seat is part of slotPols here, as
      // in the pool itself. v1.9.0: the units are the Starting
      // Pool's (basePols), and R counts the seated units the free
      // matches did not consume.
      function pricedCost() {
        var total = 0, saved = 0;
        all.forEach(function (c) {
          total += drainAt(c.rec, c.rank);
          if (matched[c.rec.name]) saved += savingOf(c);
        });
        var lp = [], lz = 0;
        all.forEach(function (c) {
          if (matched[c.rec.name]) return;
          if (polOf(c)) lp.push(drainAt(c.rec, c.rank)); else lz++;
        });
        lp.sort(function (a, b) { return a - b; });
        var restUnits = seatedLeftTotal();
        var emptyCount = slotPols.length - all.length;
        var penCount = Math.min(lp.length,
          Math.max(0, restUnits - emptyCount - lz));
        var extra = 0;
        for (var pi = 0; pi < penCount; pi++) {
          extra += Math.ceil(lp[pi] * 1.25) - lp[pi];
        }
        return total - saved + extra;
      }
      // (1) Free matches from the Starting Pool.
      var byPol = {};
      all.forEach(function (c) {
        var p = polOf(c);
        if (p) (byPol[p] = byPol[p] || []).push(c);
      });
      Object.keys(byPol).forEach(function (p) {
        var list = byPol[p].slice().sort(byDrain);
        var n = Math.min(poolCounts[p] || 0, list.length);
        for (var i = 0; i < n; i++) {
          matched[list[i].rec.name] = true;
          matchedFree.push(list[i].rec.name);
          consumeUnit(p);
        }
      });
      // (2) Forma spend, then the Umbra Forma pass (separate budget).
      // v1.9.0: additive forma needs a blank seat — once every
      // seat is polarized, further matches are conversions (the
      // gated pass below), never plain spends.
      var additiveCap = slotPols.length - seatedUnits;
      var regularUsed = 0;
      var formaCands = all.filter(function (c) {
        return !matched[c.rec.name] && polOf(c) && polOf(c) !== 'Umbra' && savingOf(c) > 0;
      }).sort(bySaving);
      for (var fi = 0; fi < formaCands.length && pricedCost() > capMax && regularUsed < remaining && regularUsed < additiveCap; fi++) {
        matched[formaCands[fi].rec.name] = true;
        matchedForma.push(formaCands[fi].rec.name);
        regularUsed++;
      }
      var umbraUsedCount = 0;
      var umbraCands = all.filter(function (c) {
        return !matched[c.rec.name] && polOf(c) === 'Umbra' && savingOf(c) > 0;
      }).sort(bySaving);
      for (var ui = 0; ui < umbraCands.length && pricedCost() > capMax && umbraUsedCount < (umbraForma || 0); ui++) {
        matched[umbraCands[ui].rec.name] = true;
        matchedUmbra.push(umbraCands[ui].rec.name);
        umbraUsedCount++;
      }
      // (2b) v1.9.0: CONVERSIONS — the last resort, mirroring the
      // frame fit: toggle on, fit still invalid, every seat
      // already polarized, budget room left inside this attempt
      // (the over-rank allocation already spent from the same
      // budget). Each conversion re-polarizes one starting-pool
      // unit into an unmatched mod's polarity for +1 forma; the
      // source unit is the first remaining one in vocabulary
      // order. Umbra mods stay Umbra-budget-only.
      var convUsed = 0;
      var matchedConverted = [];
      if (poolOpts && poolOpts.convert) {
        var convCands = all.filter(function (c) {
          return !matched[c.rec.name] && polOf(c) && polOf(c) !== 'Umbra' &&
            savingOf(c) > 0;
        }).sort(bySaving);
        for (var ci = 0; ci < convCands.length; ci++) {
          if (pricedCost() <= capMax) break;
          if (regularUsed + convUsed >= remaining) break;
          if (seatedUnits + matchedForma.length + matchedUmbra.length <
              slotPols.length) break;
          var leftUnits = poolUnitsLeft();
          var srcPol = null;
          for (var vi = 0; vi < POOL_VOCAB_ORDER.length; vi++) {
            if (leftUnits[POOL_VOCAB_ORDER[vi]] > 0) {
              srcPol = POOL_VOCAB_ORDER[vi]; break;
            }
          }
          if (!srcPol || srcPol === polOf(convCands[ci])) break;
          if (!consumeUnit(srcPol)) break;
          matched[convCands[ci].rec.name] = true;
          matchedConverted.push({ name: convCands[ci].rec.name,
            from: srcPol, to: polOf(convCands[ci]) });
          convUsed++;
        }
      }
      var priced = pricedCost();
      attempts.push({
        overRankForma: over, capacityMax: capMax, capacityUsed: priced,
        formaUsed: regularUsed + convUsed, umbraFormaUsed: umbraUsedCount,
        valid: priced <= capMax,
        totalForma: over + regularUsed + convUsed + umbraUsedCount,
        matchedFree: matchedFree, matchedForma: matchedForma,
        matchedUmbra: matchedUmbra, conversions: matchedConverted,
        // v1.9.0: the picked attempt's remaining seated units —
        // the placement's rest distribution reads these.
        seatedLeftAfter: (function () {
          var snap = {};
          Object.keys(seatedLeft).forEach(function (p) {
            snap[p] = seatedLeft[p];
          });
          return snap;
        })()
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

    // (3) Derived placement for the picked attempt, in pick order
    // (the fitCapacity discipline): each mod takes the first
    // suitable free slot — free-matched mods prefer a slot whose
    // innate polarity is theirs (the Exilus slot's unit can serve a
    // regular mod — a swap — in which case the mod lands on any
    // free slot and the polarity travels with it); forma'd mods
    // prefer a free slot with no innate polarity; leftovers ascend.
    // Pick order matters beyond cosmetics: the elemental fold
    // follows board order, and the solver's order pass optimized
    // the pick sequence. The exilus mod stays pinned to the exilus
    // slot. v1.6.0: the SHOWN polarities of the non-matched slots
    // are then distributed to mirror pricedCost's arrangement —
    // the remaining innate units land on empty slots first, then
    // on polarity-less leftovers (never penalised), and only the
    // smallest polarized leftovers still holding a unit are the
    // penalised set; the other polarized leftovers show none. The
    // multiset of shown polarities is always innate + forma-added,
    // so per-slot drains sum to the count.
    var byName = {};
    all.forEach(function (c) { byName[c.rec.name] = c; });
    var freeSet = {}, formaSet = {}, umbraSet = {}, convertedSet = {};
    pick.matchedFree.forEach(function (n) { freeSet[n] = true; });
    pick.matchedForma.forEach(function (n) { formaSet[n] = true; });
    pick.matchedUmbra.forEach(function (n) { umbraSet[n] = true; });
    (pick.conversions || []).forEach(function (cv) {
      convertedSet[cv.name] = true;
    });
    // v1.9.0: rest = the pool units still seated after the picked
    // attempt's matches (free matches and conversions consumed
    // theirs); the shown arrangement derives from basePols.
    var rest = {};
    Object.keys(pick.seatedLeftAfter || {}).forEach(function (p) {
      rest[p] = pick.seatedLeftAfter[p];
    });
    delete pick.seatedLeftAfter;
    var polOrder = [];
    basePols.forEach(function (p) { if (p && polOrder.indexOf(p) < 0) polOrder.push(p); });
    var pols = basePols.slice(); // empty slots keep showing the current arrangement
    var assign = {}, taken = {};
    function firstFreeSlot(pred) {
      for (var i = 0; i < 8; i++) if (!taken[i] && pred(i)) return i;
      return -1;
    }
    if (exilusEntry) {
      assign[exilusEntry.rec.name] = exSlotIndex;
      taken[exSlotIndex] = true;
      if (freeSet[exilusEntry.rec.name] || formaSet[exilusEntry.rec.name] ||
          umbraSet[exilusEntry.rec.name] || convertedSet[exilusEntry.rec.name]) {
        pols[exSlotIndex] = polOf(exilusEntry);
      }
    }
    var convertedByName = {};
    (pick.conversions || []).forEach(function (cv) {
      convertedByName[cv.name] = cv;
    });
    all.forEach(function (c) {
      if (exilusEntry && c === exilusEntry) return;
      var name = c.rec.name, p = polOf(c), slot = -1;
      if (freeSet[name]) slot = firstFreeSlot(function (i) { return basePols[i] === p; });
      if (slot < 0 && convertedSet[name]) {
        // v1.9.0: a converted mod prefers the seat holding its
        // source unit's polarity.
        slot = firstFreeSlot(function (i) {
          return basePols[i] === convertedByName[name].from;
        });
      }
      if (slot < 0 && (formaSet[name] || umbraSet[name] || convertedSet[name])) {
        slot = firstFreeSlot(function (i) { return !basePols[i]; });
      }
      if (slot < 0) slot = firstFreeSlot(function () { return true; });
      if (slot < 0) return;
      assign[name] = slot; taken[slot] = true;
      if (freeSet[name] || formaSet[name] || umbraSet[name] ||
          convertedSet[name]) pols[slot] = p;
    });
    // v1.6.0: distribute the remaining innate units (rest) over the
    // non-matched slots in pricedCost's arrangement order (see the
    // header comment): empty slots, then polarity-less leftovers,
    // then the smallest polarized leftovers; any slot past the
    // available units shows none, and units past the available
    // slots are simply not shown (a unit is a slot's polarity, not
    // a token that must appear).
    var restUnits = [];
    polOrder.forEach(function (p) {
      for (var k = 0; k < (rest[p] || 0); k++) restUnits.push(p);
    });
    var bySlotName = {};
    Object.keys(assign).forEach(function (n) { bySlotName[assign[n]] = n; });
    var emptySlots = [], lzSlots = [], lpSlots = [];
    for (var si = 0; si < slotPols.length; si++) {
      if (!(si in bySlotName)) { emptySlots.push(si); continue; }
      var cn = bySlotName[si];
      if (freeSet[cn] || formaSet[cn] || umbraSet[cn] ||
          convertedSet[cn]) continue;
      if (polOf(byName[cn])) lpSlots.push(si); else lzSlots.push(si);
    }
    lpSlots.sort(function (a, b) {
      var ca = byName[bySlotName[a]], cb = byName[bySlotName[b]];
      return (drainAt(ca.rec, ca.rank) - drainAt(cb.rec, cb.rank)) || (a - b);
    });
    emptySlots.concat(lzSlots, lpSlots).forEach(function (slot, idx) {
      pols[slot] = idx < restUnits.length ? restUnits[idx] : null;
    });
    var formaPlan = [];
    pick.matchedForma.forEach(function (name) {
      if (name in assign) formaPlan.push({ slot: assign[name], polarity: polOf(byName[name]) });
    });
    pick.matchedUmbra.forEach(function (name) {
      if (name in assign) formaPlan.push({ slot: assign[name], polarity: 'Umbra', umbra: true });
    });
    // v1.9.0: conversion plan entries carry their provenance.
    (pick.conversions || []).forEach(function (cv) {
      if (cv.name in assign) {
        formaPlan.push({ slot: assign[cv.name], polarity: cv.to,
          convertedFrom: cv.from });
      }
    });
    pick.formaPlan = formaPlan;
    // v1.9.0 (#25): the Starting Pool outcome (see the fit header).
    pick.poolDeclared = poolDeclared;
    pick.formaAlreadyIn = formaAlreadyIn;
    pick.poolCounts = poolCounts;
    pick.basePols = basePols;
    pick.matchedConverted = (pick.conversions || []).map(function (cv) {
      return cv.name;
    });
    // v1.1: the slot assignment + final polarities ride along — the
    // ordered slot list and the elemental-order pass derive from
    // them (single source of truth for placement).
    pick.assign = assign;
    pick.pols = pols;
    pick.matched = {
      free: pick.matchedFree, forma: pick.matchedForma, umbra: pick.matchedUmbra,
      converted: pick.matchedConverted
    };
    delete pick.matchedFree; delete pick.matchedForma; delete pick.matchedUmbra;
    pick.stance = sp.name;
    pick.stanceBonus = sp.bonus;
    return pick;
  }

  // v1.5.2: GIVEN-polarity fit for evaluateWeapon — the mirror of
  // Solver.evaluateFrame's given mode. The board's arrangement is
  // scored as-is: drain halves where the slot's assigned polarity
  // matches the mod (a 'Universal' slot matches any mod except
  // Umbra), and the Forma count comes from the pool formula —
  // polarized non-stance slots minus the multiset intersection of
  // assigned vs innate polarities (regular slots + the Exilus slot),
  // with the Umbra excess reported separately. Slot positions are
  // positional: normal entries count in board order (empty cells
  // included), the exilus entry is fit slot 8 — the parse loop in
  // evaluateWeapon stamps each accepted entry with its fit slot.
  // Capacity rides on the board's over-rank level
  // (pieces.overRankForma; derived as the smallest level whose
  // capacity holds the board when absent, e.g. a pre-v1.5.2 board).
  function givenFitWeapon(weapon, pieces, normals, exilusEntry, stances) {
    var sp = stancePickFor(weapon, stances);
    var innate = (Array.isArray(weapon.Polarities) ? weapon.Polarities : [])
      .slice(0, 8).map(slotPolOf);
    while (innate.length < 8) innate.push(null);
    if (pieces.exilusSlot || exilusEntry) innate.push(slotPolOf(weapon.ExilusPolarity));
    var polAt = {}, assigned = {}, polarized = 0, ni = 0;
    (pieces.slots || []).forEach(function (s) {
      if (!s || s.kind === 'stance') return;
      var idx = s.kind === 'exilus' ? 8 : ni++;
      var p = ('polarity' in s) ? (s.polarity || null) : null;
      polAt[idx] = p;
      if (p) { assigned[p] = (assigned[p] || 0) + 1; polarized++; }
    });
    var innateCounts = {};
    innate.forEach(function (p) { if (p) innateCounts[p] = (innateCounts[p] || 0) + 1; });
    // v1.9.0 (#25): a declared Starting Pool replaces the innate
    // baseline of the pool formula (it covers the Exilus slot too;
    // the returned pols below still show the true innate slots).
    var gAlreadyIn = 0;
    if (Array.isArray(pieces.startingPool)) {
      var poolBaseline = poolCountsOf(pieces.startingPool, {});
      Object.keys(poolBaseline).forEach(function (p) {
        gAlreadyIn += Math.max(0,
          poolBaseline[p] - (innateCounts[p] || 0));
      });
      innateCounts = poolBaseline;
    }
    var inter = 0;
    Object.keys(assigned).forEach(function (p) {
      inter += Math.min(assigned[p], innateCounts[p] || 0);
    });
    var gUmbra = Math.max(0, (assigned.Umbra || 0) - (innateCounts.Umbra || 0));
    var used = 0;
    normals.concat(exilusEntry ? [exilusEntry] : []).forEach(function (e) {
      used += drainInSlotW(drainAt(e.rec, e.rank), polAt[e._fitSlot], e.rec.polarity);
    });
    var maxRankCap = weapon.MaxRank || 30;
    var over = (Number.isInteger(pieces.overRankForma) &&
      pieces.overRankForma >= 0 && pieces.overRankForma <= 5)
      ? pieces.overRankForma : null;
    if (over === null) {
      var maxOver = Math.max(0, Math.min(5, Math.ceil((maxRankCap - 30) / 2)));
      over = maxOver;
      for (var o = 0; o <= maxOver; o++) {
        if (used <= Math.min(maxRankCap, 30 + 2 * o) * 2 + sp.bonus) { over = o; break; }
      }
    }
    var capMax = Math.min(maxRankCap, 30 + 2 * over) * 2 + sp.bonus;
    return {
      capacityUsed: used, capacityMax: capMax,
      formaUsed: (polarized - inter) - gUmbra, umbraFormaUsed: gUmbra,
      // v1.9.0: given mode performs no conversions; the split
      // still reports what the declared pool already covers.
      formaAlreadyIn: gAlreadyIn, conversions: [],
      overRankForma: over,
      valid: used <= capMax,
      stance: sp.name, stanceBonus: sp.bonus,
      formaPlan: [], assign: {}, pols: innate, matched: null
    };
  }

  // ---- solver ------------------------------------------------------------------
  // Damage types addressable as targets (v1.1): dmg:<Type> is the
  // type's final per-shot amount (per-pellet amount x multishot),
  // 0 when the type is absent from the final distribution.
  var DMG_TYPES = ['Impact', 'Puncture', 'Slash', 'Heat', 'Cold', 'Electric',
    'Toxin', 'Blast', 'Corrosive', 'Gas', 'Magnetic', 'Radiation', 'Viral', 'Void'];
  var COMBO_COMPONENTS = {
    Blast: ['Heat', 'Cold'], Radiation: ['Heat', 'Electric'],
    Gas: ['Heat', 'Toxin'], Magnetic: ['Cold', 'Electric'],
    Viral: ['Cold', 'Toxin'], Corrosive: ['Electric', 'Toxin']
  };

  function achievedOf(fwd) {
    var out = {
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
    DMG_TYPES.forEach(function (t) {
      out['dmg:' + t] = (fwd.damageByType[t] || 0) * fwd.multishot;
    });
    Object.keys(fwd.damageByType).forEach(function (t) {
      if (DMG_TYPES.indexOf(t) < 0) out['dmg:' + t] = fwd.damageByType[t] * fwd.multishot;
    });
    return out;
  }

  // ---- v1.2 cross-gear planning (parity with solver.js) -------------
  // Gear label for a support mod, from its pool Type (the loadout
  // slot a player would put it on). Melee-class types land on the
  // final fallback; anything unrecognised keeps the Melee label only
  // when it is a stance/weapon class type — set members in practice
  // carry the pool types mapped above.
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
  function crossGearModType(ctx, name) {
    var d = ctx.derivedByName && ctx.derivedByName[name];
    if (d && d.type) return d.type;
    var p = ctx.modByName && ctx.modByName[name];
    return (p && p.type) || null;
  }
  // Plan specific cross-gear mods for the FINISHED build (report
  // layer — never feeds back into the search). Same contract as
  // solver.js: candidate sets have >= 1 focus piece or an included
  // piece; selection is includes first, then members (name asc),
  // capped at the set's largest published size; excluded mods/sets,
  // focus pieces and focus-pool types are never planned.
  function crossGearPlan(ctx, o) {
    var plan = [], plannedBySet = {}, notes = [];
    if (!o.crossGear) return { plan: plan, plannedBySet: plannedBySet, notes: notes };
    var excludeSetNames = {}, excludeModNames = {};
    (Array.isArray(o.crossGear.exclude) ? o.crossGear.exclude : [])
      .forEach(function (x) {
        if (typeof x !== 'string') return;
        if (ctx.setBonuses[x]) excludeSetNames[x] = 1;
        excludeModNames[x] = 1;
      });
    var includeBySet = {};
    (Array.isArray(o.crossGear.include) ? o.crossGear.include : [])
      .forEach(function (inc) {
        var name = inc && inc.mod;
        if (!name || typeof name !== 'string') return;
        var set = ctx.setOfMod[name];
        if (!set) {
          notes.push('Cross-gear Mods include ' + name + ' skipped: it belongs to no set.');
          return;
        }
        if (excludeSetNames[set] || excludeModNames[name] || o.excludedMods[name]) {
          notes.push('Cross-gear Mods include ' + name + ' skipped: it is excluded.');
          return;
        }
        if (o.focusNames[name]) return;
        var t = crossGearModType(ctx, name);
        if (t && o.focusTypes[t]) return;
        (includeBySet[set] = includeBySet[set] || []).push(name);
      });
    var candidateSets = {};
    Object.keys(o.focusCounts).forEach(function (set) {
      if (o.focusCounts[set] > 0) candidateSets[set] = 1;
    });
    Object.keys(includeBySet).forEach(function (set) { candidateSets[set] = 1; });
    Object.keys(candidateSets).sort().forEach(function (set) {
      if (excludeSetNames[set]) return;
      var sb = ctx.setBonuses[set];
      var members = (sb && sb.members) || [];
      if (!members.length) return;
      var cap = (sb && sb.numUpgradesInSet) || members.length;
      var current = (o.focusCounts[set] || 0) +
        ((o.legacySupport && o.legacySupport[set]) || 0);
      if (current >= cap) return;
      var chosen = [];
      var ordered = (includeBySet[set] || []).slice().sort()
        .concat(members.slice().sort());
      ordered.forEach(function (name) {
        if (current >= cap) return;
        if (chosen.indexOf(name) >= 0 || o.focusNames[name]) return;
        if (excludeModNames[name] || o.excludedMods[name]) return;
        var t = crossGearModType(ctx, name);
        if (t && o.focusTypes[t]) return;
        chosen.push(name);
        current++;
      });
      chosen.forEach(function (name) {
        plan.push({ mod: name, gear: gearLabelForType(crossGearModType(ctx, name)), set: set });
      });
      if (chosen.length) plannedBySet[set] = chosen.length;
    });
    plan.sort(function (a, b) {
      return a.set < b.set ? -1 : a.set > b.set ? 1
        : (a.mod < b.mod ? -1 : a.mod > b.mod ? 1 : 0);
    });
    return { plan: plan, plannedBySet: plannedBySet, notes: notes };
  }

  // ---- v1.2 per-stat breakdown (weapons) ----------------------------
  // For totalDamagePerShot and every dmg:<Type>: a Base entry (the
  // unmodded attack, progenitor included — it is a property of the
  // weapon copy, not a mod), then one entry per occupied slot in
  // application order via prefix forwardCalc runs, then the arcane
  // as the final entry when present. cumulative values are round2;
  // the final entry equals the reported achieved value (the caller
  // passes the build's own achieved map for the last step).
  function weaponBreakdown(ctx, weapon, attackIndex, seq, fwdOpts, finalAchieved, arcaneName) {
    var noArcaneOpts = Object.assign({}, fwdOpts, { arcaneEffects: null });
    var statKeys = ['totalDamagePerShot'];
    Object.keys(finalAchieved).forEach(function (k) {
      if (k.indexOf('dmg:') === 0) statKeys.push(k);
    });
    var chains = {};
    statKeys.forEach(function (s) { chains[s] = []; });
    function pushAll(ach, source, kind) {
      statKeys.forEach(function (s) {
        chains[s].push({ source: source, kind: kind, cumulative: round2(ach[s] || 0) });
      });
    }
    pushAll(achievedOf(forwardCalc(ctx, weapon, attackIndex, [], noArcaneOpts)), 'Base', 'base');
    for (var k = 1; k <= seq.length; k++) {
      var prefix = seq.slice(0, k).map(function (p) { return { rec: p.rec, rank: p.rank }; });
      var entry = seq[k - 1];
      pushAll(achievedOf(forwardCalc(ctx, weapon, attackIndex, prefix, noArcaneOpts)),
        entry.rec.name, entry._exilus ? 'exilus' : 'mod');
    }
    if (arcaneName) pushAll(finalAchieved, arcaneName, 'arcane');
    // v1.2.1: each entry also carries its own increase over the
    // previous entry (the Base entry's delta is its own value), so
    // the chain reads "+delta -> running total" per source and the
    // deltas sum to the final cumulative.
    statKeys.forEach(function (s) {
      var prevCum = 0;
      chains[s].forEach(function (e, i) {
        e.delta = (i === 0) ? e.cumulative : round2(e.cumulative - prevCum);
        prevCum = e.cumulative;
      });
    });
    return chains;
  }

  // Split input.targets into hard targets and Maximize entries
  // (same rule as solver.js: mode 'maximize', optional priority,
  // default = order given; Maximize is handled by the fill phase).
  function splitTargets(raw) {
    var hard = {}, max = [];
    Object.keys(raw || {}).forEach(function (stat, i) {
      var t = raw[stat] || {};
      if (t.mode === 'maximize') {
        max.push({
          stat: stat,
          priority: (typeof t.priority === 'number') ? t.priority : i,
          order: i
        });
      } else {
        hard[stat] = t;
      }
    });
    max.sort(function (a, b) {
      return (a.priority - b.priority) || (a.order - b.order);
    });
    return { hard: hard, maximize: max };
  }

  // Normalise a caller-supplied mod record (derived shape, or an
  // already-classified record) into a weapon pool record. Unlike
  // buildContext this ALLOWS zero classified effects — a locked mod
  // with no modelled stats still occupies its slot (v1.1 locks).
  function weaponLockRecordNormalize(raw, nameHint) {
    if (!raw) return null;
    var maxRank = raw.maxRank || 0;
    var effs = [];
    (raw.effects || []).forEach(function (e) {
      if (!e) return;
      if (e.upgradeType) {
        var c = classifyEffect(e, maxRank);
        if (c) effs.push(c);
      } else if (e.kind) {
        effs.push(e);
      }
    });
    return {
      name: raw.name || nameHint,
      type: raw.type || null,
      polarity: raw.polarity || null,
      baseDrain: raw.baseDrain || 0,
      rarity: raw.rarity || null,
      maxRank: maxRank,
      incompatible: raw.incompatible || [],
      set: raw.set || null,
      exilus: !!raw.exilus,
      restrictedTo: raw.restrictedTo || null, // v1.4
      effects: effs
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
    // v1.2 excludes: ban pieces from every candidate pool (search
    // AND fill). A piece that is both locked and excluded is a hard
    // Error, raised in the lock loops below.
    var excludedModSet = {}, excludedArcaneSet = {};
    (Array.isArray(input.excludedMods) ? input.excludedMods : []).forEach(function (n) {
      if (typeof n === 'string') excludedModSet[n] = 1;
    });
    (Array.isArray(input.excludedArcanes) ? input.excludedArcanes : []).forEach(function (n) {
      if (typeof n === 'string') excludedArcaneSet[n] = 1;
    });
    // ---- v1.3 build intent -------------------------------------------------
    // input.intent ('window' | 'upkeep') is consulted ONLY when the
    // conditional route is on; 'window' / absent (or route off) is
    // byte-identical to v1.2. 'upkeep' prunes burst-class pieces
    // from the candidate builders below (search AND fill share
    // them). Locks override the pruning and are flagged in notes.
    var pruneBurst = routes.conditional && input.intent === 'upkeep';
    function isBurst(name) { return isBurstPiece(ctx, name); }
    // v1.4 hybrid: burst candidates stay in the pools; expand() and
    // the fill acceptance check cap SOLVER-CHOSEN burst pieces at
    // the allowance (locked pieces excluded — Q1, as in solver.js).
    var hybridW = routes.conditional && input.intent === 'hybrid';
    var burstAllowanceW = hybridW ? burstAllowanceOf(input) : 0;
    function solverBurstNamesW(st) {
      var out = [];
      st.placed.forEach(function (p) {
        if (!lockedNameSet[p.rec.name] && isBurst(p.rec.name)) out.push(p.rec.name);
      });
      if (st.exilusMod && !lockedNameSet[st.exilusMod.rec.name] &&
          isBurst(st.exilusMod.rec.name)) out.push(st.exilusMod.rec.name);
      if (st.arcane && st.arcane !== lockedArcaneName && isBurst(st.arcane)) {
        out.push(st.arcane);
      }
      return out;
    }
    // v1.1: Maximize targets split off (fill phase raises them after
    // the hard targets solve); the beam sees only the hard targets.
    var split = splitTargets(input.targets);
    var targets = split.hard;
    var maximizeList = split.maximize;
    var maxStats = maximizeList.map(function (m) { return m.stat; });
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
      // Damage-type targets (v1.1): candidacy/bracketing estimates.
      // +damage% and multishot scale every type; an elemental add
      // feeds its own type and any combined type it is a component
      // of (whether it actually survives combining depends on the
      // final order — the elemental-order pass settles that).
      if (stat.indexOf('dmg:') === 0) {
        var type = stat.slice(4);
        var perType = baseFwd.damageByType[type] || 0;
        switch (eff.kind) {
          case 'damagePct':
            return perType * baseAch.multishot * cv / 100;
          case 'multishotPct':
            return perType * baseAch.multishot * cv / 100;
          case 'faction':
            return perType * baseAch.multishot *
              ((1 + (eff.maxValue - 1) * (rank + 1) / ((eff.maxRank || 0) + 1)) - 1);
          case 'typedAdd': {
            var amt = (IPS.indexOf(eff.element) >= 0 ? ipsBase[eff.element] : effBaseTotal) *
              cv / 100 * baseAch.multishot;
            if (eff.element === type) return amt;
            var comps = COMBO_COMPONENTS[type];
            return (comps && comps.indexOf(eff.element) >= 0) ? amt : 0;
          }
          case 'convert':
            return eff.element === type
              ? effBaseTotal * cv / 100 * baseAch.multishot * 0.5 : 0;
          default: return 0;
        }
      }
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
    function candidateRanks(rec, statList) {
      var set = {};
      set[rec.maxRank] = true;
      rec.effects.forEach(function (eff) {
        if (eff.conditional && !routes.conditional) return;
        statList.forEach(function (stat) {
          // Maximize stats have no value to bracket against; use the
          // base value as the gap scale (aim to roughly double it).
          var gap = (targets[stat] && typeof targets[stat].value === 'number')
            ? targets[stat].value - (baseAch[stat] || 0)
            : Math.max(1, Math.abs(baseAch[stat] || 0));
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

    function buildCandMods(statList) {
      var out = [];
      if (!routes.mods) return out;
      pool.mods.forEach(function (rec) {
        if (excludedModSet[rec.name]) return; // v1.2 ban
        if (pruneBurst && isBurst(rec.name)) return; // v1.3 upkeep
        var touches = rec.effects.some(function (eff) {
          if (eff.conditional && !routes.conditional) return false;
          return statList.some(function (stat) {
            return Math.abs(effectDelta(eff, rec.maxRank, stat)) > 1e-12;
          });
        });
        if (touches) out.push({ rec: rec, ranks: candidateRanks(rec, statList) });
      });
      return out;
    }
    var candMods = buildCandMods(targetedStats);

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
    var arcaneByName = {};
    function arcaneTouches(eff, statList) {
      if (eff.conditional && !routes.conditional) return false;
      return statList.some(function (stat) {
        if (stat.indexOf('dmg:') === 0) {
          if (eff.kind === 'damagePct' || eff.kind === 'multishotPct') return true;
          if (eff.kind === 'typedAdd') {
            var ty = stat.slice(4);
            return eff.element === ty ||
              (COMBO_COMPONENTS[ty] || []).indexOf(eff.element) >= 0;
          }
          return false;
        }
        return (KIND_STATS[eff.kind] || []).indexOf(stat) >= 0;
      });
    }
    function buildCandArcanes(statList) {
      var names = [];
      if (!routes.arcanes || input.arcaneEffects) return names;
      ctx.arcanePool.forEach(function (entry) {
        if (!arcaneTypeMatches(entry, weapon)) return;
        var effs = arcaneEffectsForEntry(entry);
        // arcaneByName covers every type-matching entry (locked
        // arcanes and fill arcane swaps read their effects from it).
        if (!arcaneByName[entry.name]) arcaneByName[entry.name] = effs;
        if (excludedArcaneSet[entry.name]) return; // v1.2 ban
        if (pruneBurst && isBurst(entry.name)) return; // v1.3 upkeep
        if (effs.some(function (eff) { return arcaneTouches(eff, statList); })) {
          names.push(entry.name);
        }
      });
      return names;
    }
    var candArcanes = buildCandArcanes(targetedStats);

    // ---- v1.1 locks ------------------------------------------------------
    // Same contract as solver.js: lockedMods [{name, rank}] are
    // seeded before the search and never dropped or re-ranked by it
    // (capacity trim excepted, and reported); lockedArcanes (at most
    // 1 — a weapon has one arcane slot) occupy the arcane slot.
    var lockedModNames = [], lockedNameSet = {}, lockedRanksW = {};
    var poolNameSet = {}, poolTypeSet = {};
    pool.mods.forEach(function (m) {
      poolNameSet[m.name] = true;
      if (m.type) poolTypeSet[m.type] = true;
    });
    (Array.isArray(input.lockedMods) ? input.lockedMods : []).forEach(function (L) {
      var name = L && L.name;
      if (!name) throw new Error('lockedMods entries need a name.');
      if (excludedModSet[name]) {
        throw new Error('Mod ' + name + ' is both locked and excluded.');
      }
      if (lockedNameSet[name]) throw new Error('Duplicate locked mod: ' + name);
      var rec;
      if (poolNameSet[name]) {
        rec = ctx.modByName[name];
      } else {
        var raw = null;
        ((data.modsEffects && data.modsEffects.mods) || []).forEach(function (m) {
          if (m.name === name) raw = m;
        });
        if (!raw && input.extraModRecords) raw = input.extraModRecords[name];
        if (!raw) {
          throw new Error('Unknown locked mod: ' + name +
            ' (not in the weapon mod pool; pass its record via extraModRecords)');
        }
        rec = weaponLockRecordNormalize(raw, name);
        if (!poolTypeSet[rec.type] && rec.type !== weapon.Name &&
            rec.type !== weapon.Family) {
          throw new Error('Locked mod ' + name + ' (' + (rec.type || 'untyped') +
            ') cannot go on ' + input.weaponName + '.');
        }
        ctx.modByName[name] = rec;
        if (rec.set) ctx.setOfMod[name] = rec.set;
      }
      // v1.4: a mod restricted to another weapon cannot be locked
      // here (exact item match — the pool branch above can only
      // contain this weapon's restricted mods, post-poolFor).
      if (rec.restrictedTo && rec.restrictedTo !== input.weaponName) {
        throw new Error('Locked mod ' + name + ' is restricted to ' +
          rec.restrictedTo + ' and cannot go on ' + input.weaponName + '.');
      }
      lockedNameSet[name] = true;
      lockedModNames.push(name);
      lockedRanksW[name] = (typeof L.rank === 'number')
        ? Math.max(0, Math.min(rec.maxRank, Math.round(L.rank))) : rec.maxRank;
    });
    for (var li = 0; li < lockedModNames.length; li++) {
      for (var lj = li + 1; lj < lockedModNames.length; lj++) {
        var ra = ctx.modByName[lockedModNames[li]], rb = ctx.modByName[lockedModNames[lj]];
        if ((ra.incompatible || []).indexOf(rb.name) >= 0 ||
            (rb.incompatible || []).indexOf(ra.name) >= 0) {
          throw new Error('Locked mods ' + ra.name + ' and ' + rb.name + ' are incompatible.');
        }
      }
    }
    var lockedArcaneName = null;
    (Array.isArray(input.lockedArcanes) ? input.lockedArcanes : []).forEach(function (name) {
      if (excludedArcaneSet[name]) {
        throw new Error('Arcane ' + name + ' is both locked and excluded.');
      }
      if (lockedArcaneName) {
        throw new Error('At most 1 arcane can be locked (a weapon has 1 arcane slot).');
      }
      if (input.arcaneEffects) {
        throw new Error('lockedArcanes cannot be combined with injected arcaneEffects.');
      }
      var entry = null;
      ctx.arcanePool.forEach(function (a) { if (a.name === name) entry = a; });
      if (!entry) throw new Error('Unknown locked arcane: ' + name);
      if (!arcaneTypeMatches(entry, weapon)) {
        throw new Error('Locked arcane ' + name + ' (' + entry.type +
          ') does not fit ' + input.weaponName + '.');
      }
      arcaneByName[name] = arcaneEffectsForEntry(entry);
      lockedArcaneName = name;
    });

    var HARDW = { mods: candMods, arcanes: candArcanes };
    var FILLW = maximizeList.length ? {
      mods: buildCandMods(targetedStats.concat(maxStats)),
      arcanes: buildCandArcanes(maxStats)
    } : null;
    var fillModByNameW = {};
    if (FILLW) FILLW.mods.forEach(function (c) { fillModByNameW[c.rec.name] = c; });

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
        routes.stance ? pool.stances : [], input.formaBudget, input.umbraForma || 0,
        { pool: input.startingPool || null, convert: !!input.formaConvert });
      var ach = achievedOf(fwd);
      var sc = (scoreFn || scoreState)(ach, fit, state);
      return { state: state, fwd: fwd, achieved: ach, fit: fit, score: sc.score,
               shortfall: sc.shortfall, closestDist: sc.closestDist || 0 };
    }
    function expand(state, cand) {
      var out = [];
      if (state.placed.length < 8) {
        cand.mods.forEach(function (c) {
          if (!canPlace(state, c.rec)) return;
          c.ranks.forEach(function (r) {
            var ns = { placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: state.arcane };
            ns.placed.push({ rec: c.rec, rank: r });
            out.push(ns);
          });
        });
      }
      if (routes.exilus && !state.exilusMod) {
        cand.mods.forEach(function (c) {
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
        cand.arcanes.forEach(function (name) {
          out.push({ placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: name });
        });
      }
      // v1.4 hybrid: cap solver-chosen burst pieces at the allowance.
      if (hybridW) {
        return out.filter(function (ns) {
          return solverBurstNamesW(ns).length <= burstAllowanceW;
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
      // Deficit lanes (v1.1, bound as in solver.js: at most 2 extra
      // states per at-least stat, 6 per round): states below a floor
      // holding the best achieved value for that floor's stat — the
      // closest-from-below states most likely to complete with one
      // more piece.
      var extraBudget = 6;
      for (var si = 0; si < targetedStats.length && extraBudget > 0; si++) {
        var stat = targetedStats[si];
        var t = targets[stat];
        if (!t || t.mode !== 'atleast') continue;
        var lb = lowerBetter(stat);
        var below = sorted.filter(function (ev) {
          if (picked[signature(ev.state)]) return false;
          var a = ev.achieved[stat];
          if (a == null) return false;
          return lb ? a > t.value + 1e-9 : a < t.value - 1e-9;
        });
        below.sort(function (a, b) {
          return lb ? a.achieved[stat] - b.achieved[stat]
                    : b.achieved[stat] - a.achieved[stat];
        });
        below.slice(0, Math.min(2, extraBudget)).forEach(function (ev) {
          var sig = signature(ev.state);
          if (!picked[sig]) { picked[sig] = true; out.push(ev); extraBudget--; }
        });
      }
      return out.sort(function (a, b) { return a.score - b.score; });
    }

    // Beam search over the lock-seeded start states.
    function runSearch(scoreFn, startStates) {
      var beam = startStates.map(function (s) { return evaluate(s, scoreFn); });
      var bestValidEver = null;
      beam.forEach(function (ev) {
        if (ev.fit.valid) bestValidEver = ev;
      });
      for (var round = 0; round < 18; round++) {
        var seen = {}, next = [], newCount = 0;
        beam.forEach(function (ev) { seen[signature(ev.state)] = true; next.push(ev); });
        beam.forEach(function (ev) {
          expand(ev.state, HARDW).forEach(function (ns) {
            var sig = signature(ns);
            if (seen[sig]) return;
            seen[sig] = true;
            newCount++;
            next.push(evaluate(ns, scoreFn));
          });
        });
        next.forEach(function (ev) {
          if (ev.fit.valid && (!bestValidEver || ev.score < bestValidEver.score)) {
            bestValidEver = ev;
          }
        });
        beam = selectBeam(next);
        if (newCount === 0) break;
      }
      if (bestValidEver) return { ev: bestValidEver, fellBack: false };
      var finals = beam.slice().sort(function (a, b) { return a.score - b.score; });
      return { ev: finals[0], fellBack: true };
    }

    // Lock-seeded start states (exilus variants first — same tie
    // preference as the frame solver).
    function lockedStartStatesW() {
      function seeded(exilusLockName) {
        var st = emptyState();
        lockedModNames.forEach(function (n) {
          var rec = ctx.modByName[n];
          if (n === exilusLockName) st.exilusMod = { rec: rec, rank: lockedRanksW[n] };
          else st.placed.push({ rec: rec, rank: lockedRanksW[n] });
        });
        if (lockedArcaneName) st.arcane = lockedArcaneName;
        return st;
      }
      var starts = [];
      if (routes.exilus) {
        lockedModNames.forEach(function (n) {
          var rec = ctx.modByName[n];
          if (rec && rec.exilus && lockedModNames.length - 1 <= 8) starts.push(seeded(n));
        });
      }
      if (lockedModNames.length <= 8) starts.push(seeded(null));
      if (!starts.length) {
        throw new Error('Too many locked mods: ' + lockedModNames.length + ' locks for 8 slots.');
      }
      return starts;
    }

    var mainRun = runSearch(null, lockedStartStatesW());
    var chosenEv = mainRun.ev;

    // ---- v1.1 lock capacity trim (same rule as solver.js) -----------
    var trimNotes = [];
    if (lockedModNames.length && !chosenEv.fit.valid) {
      var rankInW = function (st, n) {
        for (var i = 0; i < st.placed.length; i++) {
          if (st.placed[i].rec.name === n) return st.placed[i].rank;
        }
        if (st.exilusMod && st.exilusMod.rec.name === n) return st.exilusMod.rank;
        return null;
      };
      var setRankInW = function (st, n, r) {
        for (var i = 0; i < st.placed.length; i++) {
          if (st.placed[i].rec.name === n) { st.placed[i].rank = r; return; }
        }
        if (st.exilusMod && st.exilusMod.rec.name === n) st.exilusMod.rank = r;
      };
      var cloneStateW = function (st) {
        return {
          placed: st.placed.map(function (p) { return { rec: p.rec, rank: p.rank }; }),
          exilusMod: st.exilusMod ? { rec: st.exilusMod.rec, rank: st.exilusMod.rank } : null,
          arcane: st.arcane
        };
      };
      var tst = cloneStateW(chosenEv.state);
      var beforeRanks = {};
      lockedModNames.forEach(function (n) { beforeRanks[n] = rankInW(tst, n); });
      var tev = chosenEv, trimGuard = 0;
      while (!tev.fit.valid && trimGuard++ < 500) {
        var pickName = null, pickDrain = -1;
        lockedModNames.forEach(function (n) {
          var r = rankInW(tst, n);
          if (r == null || r <= 0) return;
          var d = drainAt(ctx.modByName[n], r);
          if (d > pickDrain) { pickDrain = d; pickName = n; }
        });
        if (!pickName) break;
        setRankInW(tst, pickName, rankInW(tst, pickName) - 1);
        tev = evaluate(tst, null);
      }
      lockedModNames.forEach(function (n) {
        var after = rankInW(tst, n);
        if (after != null && beforeRanks[n] != null && after < beforeRanks[n]) {
          trimNotes.push('Locked ' + n + ' rank reduced ' + beforeRanks[n] +
            '→' + after + ' to fit capacity');
        }
      });
      if (trimNotes.length) chosenEv = tev;
    }

    // ---- v1.1 elemental order / physical slot order ------------------
    // The board presents mods in physical slot order (the fit's
    // assignment), and the forward model must match the board — so
    // the final arrangement is re-expressed in slot order, and the
    // elemental mods' relative order (which drives combining) is
    // optimised over the elemental-occupied slots. Placement rule:
    // non-elemental mods keep their fit-assigned slots; only the
    // elemental mods permute among the slots elemental mods already
    // occupy (cap 120 permutations), the exilus position may only
    // receive an exilus-flagged mod, and a permutation is legal only
    // if the build still fits with the same polarity plan.
    function isElementalRec(rec) {
      return rec.effects.some(function (e) {
        return e.kind === 'typedAdd' && isElem(e.element) &&
               (!e.conditional || routes.conditional);
      });
    }
    function uniquePermutations(entries, cap) {
      var out = [];
      (function rec(prefix, rest) {
        if (out.length >= cap) return;
        if (!rest.length) { out.push(prefix); return; }
        for (var i = 0; i < rest.length; i++) {
          rec(prefix.concat([rest[i]]), rest.slice(0, i).concat(rest.slice(i + 1)));
          if (out.length >= cap) return;
        }
      })([], entries);
      return out;
    }
    function maximizeVectorW(ach) {
      return maximizeList.map(function (m) { return ach[m.stat]; });
    }
    function vecGreaterW(a, b) {
      for (var i = 0; i < a.length; i++) {
        if (a[i] > b[i] + 1e-9) return true;
        if (a[i] < b[i] - 1e-9) return false;
      }
      return false;
    }
    function finalizeOrder(evRes) {
      var st = evRes.state;
      var fit = evRes.fit;
      if (!fit.assign || !fit.pols) return evRes;
      var normals = st.placed.slice().sort(function (a, b) {
        return fit.assign[a.rec.name] - fit.assign[b.rec.name];
      });
      var seqAll = normals.slice();
      if (st.exilusMod) {
        seqAll.push({ rec: st.exilusMod.rec, rank: st.exilusMod.rank, _exilus: true });
      }
      var physSlot = seqAll.map(function (p) { return fit.assign[p.rec.name]; });
      var elemPos = [];
      seqAll.forEach(function (p, i) { if (isElementalRec(p.rec)) elemPos.push(i); });
      var hasProg = !!(fwdOpts.progenitor && weapon.IsLichWeapon);
      if (elemPos.length < 2 && !(elemPos.length >= 1 && hasProg)) {
        var nst = { placed: normals, exilusMod: st.exilusMod, arcane: st.arcane };
        return evaluate(nst, null);
      }
      var elemEntries = elemPos.map(function (i) { return seqAll[i]; });
      var exIdx = -1;
      seqAll.forEach(function (p, i) { if (p._exilus) exIdx = i; });
      function tryPerm(perm) {
        var cand = seqAll.slice();
        elemPos.forEach(function (pos, k) { cand[pos] = perm[k]; });
        if (exIdx >= 0 && !cand[exIdx].rec.exilus) return null;
        var cost = 0;
        cand.forEach(function (p, i) {
          cost += drainInSlotW(drainAt(p.rec, p.rank),
            fit.pols[physSlot[i]], p.rec.polarity);
        });
        if (cost > fit.capacityMax) return null;
        var opts = fwdOpts;
        if (st.arcane) {
          opts = Object.assign({}, fwdOpts, {
            arcaneEffects: arcaneByName[st.arcane] || []
          });
        }
        var fwd = forwardCalc(ctx, weapon, input.attackIndex,
          cand.map(function (p) { return { rec: p.rec, rank: p.rank }; }), opts);
        var ach = achievedOf(fwd);
        var sc = scoreState(ach, fit, st);
        return { cand: cand, cost: cost, fwd: fwd, ach: ach, score: sc.score };
      }
      var best = null;
      uniquePermutations(elemEntries, 120).forEach(function (perm) {
        var r = tryPerm(perm);
        if (!r) return;
        if (!best || r.score < best.score - 1e-9 ||
            (Math.abs(r.score - best.score) <= 1e-9 &&
             (vecGreaterW(maximizeVectorW(r.ach), maximizeVectorW(best.ach)) ||
              (!vecGreaterW(maximizeVectorW(best.ach), maximizeVectorW(r.ach)) &&
               r.cost < best.cost)))) {
          best = r;
        }
      });
      if (!best) {
        var nst0 = { placed: normals, exilusMod: st.exilusMod, arcane: st.arcane };
        return evaluate(nst0, null);
      }
      var newPlaced = [], newExilus = null, newAssign = {};
      best.cand.forEach(function (p, i) {
        newAssign[p.rec.name] = physSlot[i];
        var entry = { rec: p.rec, rank: p.rank };
        if (st.exilusMod && i === best.cand.length - 1) newExilus = entry;
        else newPlaced.push(entry);
      });
      var newState = { placed: newPlaced, exilusMod: newExilus, arcane: st.arcane };
      var newFit = Object.assign({}, fit, {
        capacityUsed: best.cost, assign: newAssign,
        valid: best.cost <= fit.capacityMax
      });
      var scf = scoreState(best.ach, newFit, newState);
      return { state: newState, fwd: best.fwd, achieved: best.ach, fit: newFit,
               score: scf.score, shortfall: scf.shortfall, closestDist: scf.closestDist };
    }

    // ---- v1.1 fill phase (same discipline as solver.js) -------------
    function guardOkW(evNew, anchor) {
      for (var i = 0; i < targetedStats.length; i++) {
        var stat = targetedStats[i], t = targets[stat];
        var aNew = evNew.achieved[stat], aOld = anchor.achieved[stat];
        if (aNew == null || aOld == null) { if (aNew !== aOld) return false; continue; }
        if (t.mode === 'atleast') {
          if (lowerBetter(stat)) {
            if (aOld <= t.value + 1e-9) { if (aNew > t.value + 1e-9) return false; }
            else if (aNew > aOld + 1e-9) return false;
          } else {
            if (aOld >= t.value - 1e-9) { if (aNew < t.value - 1e-9) return false; }
            else if (aNew < aOld - 1e-9) return false;
          }
        } else if (t.mode === 'closest') {
          if (Math.abs(aNew - t.value) > Math.abs(aOld - t.value) + 1e-9) return false;
        }
      }
      return true;
    }
    function fillExtraMovesW(state) {
      var out = [];
      state.placed.forEach(function (p, idx) {
        if (lockedNameSet[p.rec.name]) return;
        var c = fillModByNameW[p.rec.name];
        if (c) c.ranks.forEach(function (r) {
          if (r > p.rank) {
            var ns = { placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: state.arcane };
            ns.placed[idx] = { rec: p.rec, rank: r };
            out.push(ns);
          }
        });
        FILLW.mods.forEach(function (cc) {
          if (cc.rec.name === p.rec.name) return;
          if (!canPlace({ placed: state.placed.filter(function (_, j) { return j !== idx; }),
                          exilusMod: state.exilusMod, arcane: state.arcane }, cc.rec)) return;
          cc.ranks.forEach(function (r) {
            var ns = { placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: state.arcane };
            ns.placed[idx] = { rec: cc.rec, rank: r };
            out.push(ns);
          });
        });
      });
      if (state.exilusMod && !lockedNameSet[state.exilusMod.rec.name]) {
        var ce = fillModByNameW[state.exilusMod.rec.name];
        if (ce) ce.ranks.forEach(function (r) {
          if (r > state.exilusMod.rank) {
            out.push({ placed: state.placed.slice(),
                       exilusMod: { rec: state.exilusMod.rec, rank: r }, arcane: state.arcane });
          }
        });
      }
      // Arcane swaps (setting an empty slot is expand's job).
      if (state.arcane && state.arcane !== lockedArcaneName) {
        FILLW.arcanes.forEach(function (name) {
          if (name === state.arcane) return;
          out.push({ placed: state.placed.slice(), exilusMod: state.exilusMod, arcane: name });
        });
      }
      return out;
    }
    function fillPhaseW(anchorEv) {
      var cur = anchorEv;
      var changed = false;
      for (var iter = 0; iter < 40; iter++) {
        var moves = expand(cur.state, FILLW).concat(fillExtraMovesW(cur.state));
        var best = null;
        moves.forEach(function (ns) {
          // v1.4 hybrid: fillExtraMovesW bypasses expand(), so the
          // burst allowance is re-checked here for every move.
          if (hybridW && solverBurstNamesW(ns).length > burstAllowanceW) return;
          var ev = evaluate(ns, null);
          if (!ev.fit.valid) return;
          if (!guardOkW(ev, anchorEv)) return;
          if (!vecGreaterW(maximizeVectorW(ev.achieved), maximizeVectorW(cur.achieved))) return;
          var cand = {
            ev: ev,
            slotsDelta: modCountOf(ns) - modCountOf(cur.state),
            drainDelta: ev.fit.capacityUsed - cur.fit.capacityUsed
          };
          if (!best) { best = cand; return; }
          var va = maximizeVectorW(cand.ev.achieved), vb = maximizeVectorW(best.ev.achieved);
          var cmp = 0;
          for (var i = 0; i < va.length; i++) {
            if (va[i] > vb[i] + 1e-9) { cmp = 1; break; }
            if (va[i] < vb[i] - 1e-9) { cmp = -1; break; }
          }
          if (cmp > 0 ||
              (cmp === 0 && (cand.slotsDelta < best.slotsDelta ||
                (cand.slotsDelta === best.slotsDelta &&
                 cand.drainDelta < best.drainDelta - 1e-9)))) {
            best = cand;
          }
        });
        if (!best) break;
        cur = best.ev;
        changed = true;
      }
      return { ev: cur, changed: changed };
    }

    chosenEv = finalizeOrder(chosenEv);
    var anchorEv = chosenEv;
    var fillChanged = false;
    if (maximizeList.length && FILLW && anchorEv.fit.valid) {
      var fillRes = fillPhaseW(anchorEv);
      if (fillRes.changed &&
          signature(fillRes.ev.state) !== signature(anchorEv.state)) {
        chosenEv = finalizeOrder(fillRes.ev);
        fillChanged = true;
      }
    }

    // Piece origins (v1.1): 'target' vs 'fill', as in solver.js.
    function computeOriginsW(anchorState, finalState) {
      var modOrigin = {};
      function rankOf(st, n) {
        for (var i = 0; i < st.placed.length; i++) {
          if (st.placed[i].rec.name === n) return st.placed[i].rank;
        }
        if (st.exilusMod && st.exilusMod.rec.name === n) return st.exilusMod.rank;
        return null;
      }
      finalState.placed.forEach(function (p) {
        modOrigin[p.rec.name] = (rankOf(anchorState, p.rec.name) === p.rank) ? 'target' : 'fill';
      });
      if (finalState.exilusMod) {
        modOrigin[finalState.exilusMod.rec.name] =
          (rankOf(anchorState, finalState.exilusMod.rec.name) === finalState.exilusMod.rank)
          ? 'target' : 'fill';
      }
      return {
        mods: modOrigin,
        arcane: finalState.arcane
          ? (finalState.arcane === anchorState.arcane ? 'target' : 'fill') : null
      };
    }
    var originsW = fillChanged ? computeOriginsW(anchorEv.state, chosenEv.state) : null;

    // ---- v1.3 sustained floor (parity with solver.js) ------------------
    // The final build re-evaluated with burst-class pieces removed,
    // via evaluateWeapon on the filtered board — no new math.
    // Present only when the build actually uses ≥1 burst piece
    // (mod, exilus or arcane); otherwise null. The evaluator stays
    // intent-free: it scores the pieces it is given; filtering
    // happens here.
    function sustainedForW(st, slots) {
      var hasBurst = false;
      var kept = [];
      (slots || []).forEach(function (s) {
        if (!s.mod || s.kind === 'stance') return;
        if (isBurst(s.mod)) { hasBurst = true; return; }
        kept.push({ kind: s.kind, mod: s.mod, rank: s.rank });
      });
      var arcane = st.arcane || null;
      if (arcane && isBurst(arcane)) { hasBurst = true; arcane = null; }
      if (!hasBurst) return null;
      var ev = evaluateWeapon(data, input.weaponName, input.attackIndex, {
        slots: kept, arcane: arcane,
        arcaneEffects: input.arcaneEffects || null,
        conditional: routes.conditional,
        formaBudget: input.formaBudget, umbraForma: input.umbraForma || 0,
        extraModRecords: input.extraModRecords
      }, input.progenitor || null);
      return { achieved: ev.achieved, breakdown: ev.breakdown };
    }

    function buildResult(evRes, org) {
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
    // v1.2 cross-gear plan for THIS finished build. Planned pieces
    // count in the set totals immediately (support gear treated as
    // already built); supportPieces keeps the legacy counts only.
    var focusNamesW = {}, focusCountsW = {};
    st.placed.forEach(function (p) { focusNamesW[p.rec.name] = 1; });
    if (st.exilusMod) focusNamesW[st.exilusMod.rec.name] = 1;
    Object.keys(counts).forEach(function (set) { focusCountsW[set] = counts[set].focus; });
    var focusTypesW = {};
    (pool.types || []).forEach(function (t) { focusTypesW[t] = 1; });
    if (weapon.Name) focusTypesW[weapon.Name] = 1;
    if (weapon.Family) focusTypesW[weapon.Family] = 1;
    var cgW = crossGearPlan(ctx, {
      crossGear: input.crossGear || null,
      focusCounts: focusCountsW, focusNames: focusNamesW,
      legacySupport: input.supportSetPieces || null,
      focusTypes: focusTypesW, excludedMods: excludedModSet
    });
    cgW.notes.forEach(function (n) { notes.push(n); });
    var bonusSets = {};
    Object.keys(counts).forEach(function (set) { bonusSets[set] = 1; });
    Object.keys(cgW.plannedBySet).forEach(function (set) { bonusSets[set] = 1; });
    var setBonuses = [];
    Object.keys(bonusSets).forEach(function (set) {
      var sb = ctx.setBonuses[set];
      var cc = counts[set] || { focus: 0, support: 0 };
      var planned = cgW.plannedBySet[set] || 0;
      var pieces = cc.focus + cc.support + planned;
      var appliedW = !!(sb && sb.enhanceByMod && cc.focus >= 2);
      setBonuses.push({
        set: set, pieces: pieces, focusPieces: cc.focus,
        supportPieces: cc.support, plannedPieces: planned,
        parseStatus: sb ? sb.parseStatus : 'unknown',
        perPiece: sb ? sb.perPiece : null,
        totalValue: (sb && sb.perPiece && sb.perPiece.length === 1 &&
                     typeof sb.perPiece[0].value === 'number')
          ? sb.perPiece[0].value * pieces : null,
        applied: appliedW,
        sourceText: sb ? sb.sourceText : ''
      });
      if (pieces >= 2 && sb && !appliedW && sb.parseStatus !== 'parsed') {
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
      return { name: p.rec.name, rank: p.rank, slot: slot, rankCost: rc,
               origin: (org && org.mods && org.mods[p.rec.name]) || 'target' };
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

    // Ordered slot list (v1.1): stance first (kind 'stance'), then
    // the 8 normal slots in physical slot order (empty slots
    // included), then the exilus slot when the route is on or a mod
    // sits in it. Placement/polarity/drain derive from the fit's
    // assignment — the single source of truth.
    var slots = [];
    if (pool.stances.length) {
      var stanceRec = null;
      pool.stances.forEach(function (s) { if (s.name === evRes.fit.stance) stanceRec = s; });
      slots.push({
        kind: 'stance', fitSlot: null, mod: evRes.fit.stance || null,
        rank: stanceRec ? stanceRec.maxRank : null,
        slotPolarity: weapon.StancePolarity || null,
        innatePolarity: weapon.StancePolarity || null,
        formaApplied: false, umbraFormaApplied: false,
        effectiveDrain: evRes.fit.stance ? -(evRes.fit.stanceBonus || 0) : 0,
        origin: 'target'
      });
    }
    var nameAtSlot = {}, recAt = {};
    Object.keys(evRes.fit.assign || {}).forEach(function (n) {
      nameAtSlot[evRes.fit.assign[n]] = n;
    });
    st.placed.forEach(function (p) { recAt[p.rec.name] = p; });
    if (st.exilusMod) recAt[st.exilusMod.rec.name] = st.exilusMod;
    function slotEntry(kind, fitSlot, name, innate) {
      var pp = name ? recAt[name] : null;
      var planE = null;
      (evRes.fit.formaPlan || []).forEach(function (fp) {
        if (fp.slot === fitSlot) planE = fp;
      });
      var pol = evRes.fit.pols ? evRes.fit.pols[fitSlot] : null;
      var drain = 0;
      if (pp) drain = drainInSlotW(drainAt(pp.rec, pp.rank), pol, pp.rec.polarity);
      return {
        kind: kind, fitSlot: fitSlot, mod: name || null,
        rank: pp ? pp.rank : null,
        slotPolarity: pol, innatePolarity: innate,
        formaApplied: !!planE, umbraFormaApplied: !!(planE && planE.umbra),
        effectiveDrain: drain,
        origin: name ? ((org && org.mods && org.mods[name]) || 'target') : 'target'
      };
    }
    for (var si2 = 0; si2 < 8; si2++) {
      slots.push(slotEntry('normal', si2, nameAtSlot[si2] || null,
        (weapon.Polarities || [])[si2] || null));
    }
    if (st.exilusMod || routes.exilus) {
      var exPolW = weapon.ExilusPolarity;
      if (exPolW === 'None' || exPolW === '') exPolW = null;
      slots.push(slotEntry('exilus', 8,
        st.exilusMod ? st.exilusMod.rec.name : null, exPolW));
    }
    slots.forEach(function (s, i) { s.index = i; });

    // v1.2 breakdown: prefix forwards down the slot order (placed
    // mods in physical order, exilus last — evaluate()'s convention).
    var bdSeq = st.placed.map(function (p) { return { rec: p.rec, rank: p.rank }; });
    if (st.exilusMod) {
      bdSeq.push({ rec: st.exilusMod.rec, rank: st.exilusMod.rank, _exilus: true });
    }
    var bdOpts = fwdOpts;
    if (st.arcane) {
      bdOpts = Object.assign({}, fwdOpts, {
        arcaneEffects: arcaneByName[st.arcane] || []
      });
    }
    var breakdown = weaponBreakdown(ctx, weapon, input.attackIndex, bdSeq,
      bdOpts, evRes.achieved,
      st.arcane || (fwdOpts.arcaneEffects ? 'Arcane effects' : null));

    // v1.4 hybrid: name the solver-chosen burst pieces + allowance.
    var hybridBurst = hybridW ? solverBurstNamesW(st) : null;
    if (hybridW) {
      notes.push('Hybrid: ' + hybridBurst.length + ' of ' +
        burstAllowanceW + ' burst pieces used' +
        (hybridBurst.length ? ' — ' + hybridBurst.join(', ') : '') + '.');
    }

    // v1.9.0 (#25): Starting Pool reporting — conversions first
    // (they cost forma), then pure-rearrangement guidance, then
    // the no-new-forma note for a declared pool.
    (evRes.fit.conversions || []).forEach(function (cv) {
      notes.push('Forma conversion: the ' + cv.from + ' polarity in ' +
        'your Starting Pool was converted to ' + cv.to + ' for ' +
        cv.name + ' (+1 Forma — the last-resort pass; every other ' +
        'slot was already polarized).');
    });
    if (evRes.fit.basePols && evRes.fit.pols) {
      var formaSeatsW = {};
      (evRes.fit.formaPlan || []).forEach(function (p) {
        formaSeatsW[p.slot] = true;
      });
      var exIdxW = evRes.fit.basePols.length > 8 ? 8 : -1;
      swapLinesFor(evRes.fit.basePols, evRes.fit.pols, formaSeatsW,
        exIdxW).forEach(function (n) { notes.push(n); });
    }
    if (evRes.fit.poolDeclared && evRes.fit.totalForma === 0 &&
        !(evRes.fit.conversions || []).length) {
      notes.push('No new Forma needed — this plan works with the ' +
        'polarities in your Starting Pool as declared.');
    }

    return {
      achieved: achieved,
      breakdown: breakdown,
      sustained: sustainedForW(st, slots),
      hybridBurst: hybridBurst,
      crossGearPlan: cgW.plan,
      forward: evRes.fwd,
      arrangement: {
        mods: costedMods,
        slots: slots,
        origins: org || null,
        arcane: st.arcane || null,
        stance: evRes.fit.stance,
        formaUsed: evRes.fit.formaUsed,
        overRankForma: evRes.fit.overRankForma,
        umbraFormaUsed: evRes.fit.umbraFormaUsed || 0,
        // v1.9.0 (#25): the Starting Pool split (see fitWeapon).
        formaAlreadyIn: evRes.fit.formaAlreadyIn || 0,
        poolDeclared: !!evRes.fit.poolDeclared,
        conversions: evRes.fit.conversions || [],
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

    var result = buildResult(chosenEv, originsW);
    if (mainRun.fellBack) {
      result.notes.unshift('No arrangement within the Forma budget fits the mod capacity; showing the best-scoring arrangement, which exceeds capacity.');
    }
    trimNotes.forEach(function (n) { result.notes.push(n); });
    // v1.3: locked burst pieces kept in an upkeep build are flagged
    // — the lock overrode the pruning.
    if (pruneBurst) {
      lockedModNames.forEach(function (n) {
        if (isBurst(n)) {
          result.notes.push('Locked ' + n + ' is a burst piece kept in an upkeep build because it is locked.');
        }
      });
      if (lockedArcaneName && isBurst(lockedArcaneName)) {
        result.notes.push('Locked ' + lockedArcaneName + ' is a burst piece kept in an upkeep build because it is locked.');
      }
    }
    if (lockedModNames.length || lockedArcaneName) {
      var lockNames = lockedModNames.concat(lockedArcaneName ? [lockedArcaneName] : []);
      result.unmetTargets.forEach(function (u) {
        result.notes.push('Locked piece(s) ' + lockNames.join(', ') +
          ' are fixed in this build; with them, ' + u.stat +
          ' tops out at ' + u.achieved + ' (target ' + u.target + ').');
      });
    }
    result.fillPieces = [];
    if (originsW) {
      Object.keys(originsW.mods).forEach(function (n) {
        if (originsW.mods[n] === 'fill') result.fillPieces.push({ kind: 'mod', name: n });
      });
      if (originsW.arcane === 'fill' && chosenEv.state.arcane) {
        result.fillPieces.push({ kind: 'arcane', name: chosenEv.state.arcane });
      }
      result.notes.push('Fill phase (Maximize: ' +
        maximizeList.map(function (m) { return m.stat; }).join(', ') +
        ') spent leftover slots/capacity/Forma on ' + result.fillPieces.length +
        ' piece(s): ' + result.fillPieces.map(function (p) { return p.name; }).join(', ') +
        '. The pre-fill build is reported as the cheapest variant.');
    }
    // Cheapest (v1.1 redefinition, parity with solver.js): the
    // no-fill solve when the fill phase changed the build; else null.
    result.cheapest = null;
    if (fillChanged) {
      var ch = buildResult(anchorEv, null);
      result.cheapest = {
        achieved: ch.achieved, arrangement: ch.arrangement,
        setBonuses: ch.setBonuses, unmetTargets: ch.unmetTargets,
        totalRankCost: ch.totalRankCost,
        breakdown: ch.breakdown, crossGearPlan: ch.crossGearPlan,
        sustained: ch.sustained,
        hybridBurst: ch.hybridBurst
      };
    }
    return result;
  }

  // ---- forward evaluator (v1.1, for the board editor) ------------------
  // evaluateWeapon(data, weaponName, attackIndex, orderedPieces,
  // progenitor) scores ONE given arrangement with the solver's own
  // forward model + fitting (forwardCalc + fitWeapon — no second
  // implementation).
  // v1.3: evaluators are intent-free by design — they score the
  // exact piece list given and never drop pieces; intent pruning
  // lives in solve() (candidate pools) and in the sustained-floor
  // filter at the buildResult call site. orderedPieces = {
  //   slots: [{kind: 'stance'|'normal'|'exilus', mod, rank,
  //     polarity?}] in board order (the elemental sequence follows
  //     this order exactly; a polarity on any non-stance slot
  //     switches scoring to GIVEN mode, v1.5.2),
  //   arcane: name | null, arcaneEffects: [...] (optional override),
  //   conditional, formaBudget, umbraForma, stance: false to disable,
  //   exilusSlot: true when the board carries an (even empty) exilus
  //     cell — its innate polarity joins the given-mode pool,
  //   overRankForma: the board's over-rank level (given mode),
  //   supportSetPieces (unused here — set bonuses don't move weapon
  //     paper stats), extraModRecords: {name: record}
  // } -> {achieved (incl. dmg:<Type>), forward, capacityUsed,
  //       capacityMax, formaUsed, overRankForma, umbraFormaUsed,
  //       valid, warnings, plan (fit mode only)}
  function evaluateWeapon(data, weaponName, attackIndex, orderedPieces, progenitor) {
    orderedPieces = orderedPieces || {};
    var ctx = buildContext(data);
    var weapon = ctx.weapons[weaponName];
    if (!weapon) throw new Error('Unknown weapon: ' + weaponName);
    var pool = poolFor(ctx, weapon);
    if (!pool.slotSupported) {
      throw new Error('Weapon slot not supported by the weapon solver: ' + weapon.Slot +
                       ' (' + weaponName + ')');
    }
    Object.keys(orderedPieces.extraModRecords || {}).forEach(function (name) {
      if (!ctx.modByName[name]) {
        var rec = weaponLockRecordNormalize(orderedPieces.extraModRecords[name], name);
        if (rec) {
          ctx.modByName[name] = rec;
          if (rec.set) ctx.setOfMod[name] = rec.set;
        }
      }
    });
    var warnings = [];
    var normals = [], exilusEntry = null, seq = [];
    var seenNames = {};
    // v1.5.2: fit-slot positions are positional — every normal entry
    // (empty cells included) consumes the next fit slot, the exilus
    // entry is fit slot 8; accepted entries are stamped for the
    // given-polarity fit.
    var fitPos = 0;
    (orderedPieces.slots || []).forEach(function (s) {
      if (!s || s.kind === 'stance') return;
      var myFitSlot = s.kind === 'exilus' ? 8 : fitPos++;
      if (!s.mod) return;
      var rec = ctx.modByName[s.mod];
      if (!rec) {
        warnings.push('Unknown mod "' + s.mod + '" ignored — not in the ' +
          'solver pool (pass its record via extraModRecords to include it).');
        return;
      }
      if (seenNames[s.mod]) {
        warnings.push('Duplicate mod "' + s.mod + '" counted once.');
        return;
      }
      seenNames[s.mod] = true;
      var rank = (typeof s.rank === 'number')
        ? Math.max(0, Math.min(rec.maxRank, Math.round(s.rank))) : rec.maxRank;
      var entry = { rec: rec, rank: rank, _fitSlot: myFitSlot };
      seq.push(entry); // sequence position = board position
      if (s.kind === 'exilus') {
        if (exilusEntry) {
          warnings.push('Two mods in the exilus slot; "' + s.mod + '" ignored.');
          return;
        }
        if (!rec.exilus) {
          warnings.push('"' + s.mod + '" is not exilus-flagged but sits in the exilus slot.');
        }
        exilusEntry = entry;
      } else {
        normals.push(entry);
      }
    });
    var arcaneEffects = orderedPieces.arcaneEffects || null;
    if (!arcaneEffects && orderedPieces.arcane) {
      var entry2 = null;
      ctx.arcanePool.forEach(function (a) { if (a.name === orderedPieces.arcane) entry2 = a; });
      if (!entry2) {
        warnings.push('Unknown arcane "' + orderedPieces.arcane + '"; it occupies the slot only.');
        arcaneEffects = [];
      } else if (!arcaneTypeMatches(entry2, weapon)) {
        warnings.push('Arcane "' + orderedPieces.arcane + '" does not fit this ' +
          'weapon type; it occupies the slot only.');
        arcaneEffects = [];
      } else {
        arcaneEffects = arcaneEffectsForEntry(entry2);
      }
    }
    var fwd = forwardCalc(ctx, weapon, attackIndex, seq, {
      conditional: !!orderedPieces.conditional,
      progenitor: progenitor || null,
      arcaneEffects: arcaneEffects
    });
    // v1.5.2: a polarity on any non-stance slot entry switches to
    // GIVEN mode (the board's arrangement priced as-is, pool formula
    // for the count); without polarities the optimal pool fit runs
    // and its matched plan rides along for Re-Forma.
    var anyGivenW = (orderedPieces.slots || []).some(function (s) {
      return s && s.kind !== 'stance' && ('polarity' in s);
    });
    var fit = null, plan = null;
    if (anyGivenW) {
      fit = givenFitWeapon(weapon, orderedPieces, normals, exilusEntry,
        orderedPieces.stance === false ? [] : pool.stances);
    } else {
      fit = fitWeapon(ctx, weapon, normals, exilusEntry,
        orderedPieces.stance === false ? [] : pool.stances,
        orderedPieces.formaBudget != null ? orderedPieces.formaBudget : 'any',
        orderedPieces.umbraForma || 0,
        { pool: orderedPieces.startingPool || null,
          convert: !!orderedPieces.formaConvert });
      plan = fit.matched || null;
    }
    if (!fit.valid) {
      warnings.push('Capacity exceeded: ' + fit.capacityUsed +
        ' used / ' + fit.capacityMax + ' max.');
    }
    var achievedRaw = achievedOf(fwd);
    var achieved = {};
    Object.keys(achievedRaw).forEach(function (k) {
      var v = achievedRaw[k];
      achieved[k] = (typeof v === 'number') ? round2(v) : v;
    });
    // v1.2 breakdown: prefix forwards down the board's own sequence
    // (the same seq the forward run used; the exilus entry flagged).
    var bdSeqEv = seq.map(function (p) {
      return { rec: p.rec, rank: p.rank, _exilus: p === exilusEntry };
    });
    var breakdown = weaponBreakdown(ctx, weapon, attackIndex, bdSeqEv, {
      conditional: !!orderedPieces.conditional,
      progenitor: progenitor || null,
      arcaneEffects: arcaneEffects
    }, achievedRaw,
      orderedPieces.arcane || (arcaneEffects ? 'Arcane effects' : null));
    return {
      achieved: achieved,
      breakdown: breakdown,
      forward: fwd,
      capacityUsed: fit.capacityUsed,
      capacityMax: fit.capacityMax,
      formaUsed: fit.formaUsed,
      overRankForma: fit.overRankForma,
      umbraFormaUsed: fit.umbraFormaUsed || 0,
      // v1.9.0 (#25): the Starting Pool split for the board line.
      formaAlreadyIn: fit.formaAlreadyIn || 0,
      conversions: fit.conversions || [],
      poolCounts: fit.poolCounts || null,
      valid: fit.valid,
      warnings: warnings,
      plan: plan
    };
  }

  var WeaponSolver = {
    solve: solve,
    forward: forward,
    evaluateWeapon: evaluateWeapon,
    _internal: {
      buildContext: buildContext,
      poolFor: poolFor,
      forwardCalc: forwardCalc,
      fitWeapon: fitWeapon,
      polMatches: polMatches, // v1.5.2
      slotPolOf: slotPolOf, // v1.5.2
      stancePickFor: stancePickFor, // v1.5.2
      givenFitWeapon: givenFitWeapon, // v1.5.2
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
