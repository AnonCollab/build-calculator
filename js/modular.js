/*
 * modular.js — modular assembly (Kitguns / Zaws / Amps) + MOA / Hound
 * body assembly + the Amp arcane solve. Stage S3 (2026-10-18).
 *
 * UMD, zero dependencies, Node-testable (tests/modular.test.js).
 *
 * Data bundle:
 *   {
 *     modular:       data/raw/modular_data.json        ({Zaw, KitgunPrimary, KitgunSecondary, MOA, Hound})
 *     weapons:       data/raw/weapons_data.json        (name -> entry; shell templates + Amp parts)
 *     braces:        data/derived/amp_braces.json      ({braces: {name: {...}}})
 *     arcaneEffects: data/derived/arcane_effects_full.json ({arcanes: [...]})  // amp solve only
 *   }
 *
 * ASSEMBLY RULES — every rule is cited to its source; part stats come
 * from the data stores, never typed from memory.
 *
 * Kitguns (wiki "Kitgun" page): the CHAMBER carries per-grip and
 * per-loader tables in Module:Modular/data:
 *   Damage / FireRate / Range  = chamber.<field>[gripName]  (Range and
 *     FireRate may also be scalars — beam chambers set range per grip,
 *     fire rate constant)
 *   CritChance / StatusChance / CritMultiplier = chamber + loader
 *   Magazine = chamber.Magazine[loader.Magazine]  (size-tier keyed)
 *   Reload   = loader.Reload
 *   Everything else (Trigger, Multishot, ShotType, Falloff, spread,
 *   Accuracy, ammo, PunchThrough, ForcedProcs) from the chamber.
 * The grip determines primary vs secondary (the Kitgun page's Grip
 * section: "The Grip determines whether the Kitgun will be a primary
 * weapon or a secondary weapon"); LOADER STAT BLOCKS ARE SHARED
 * between the two families — the family is whichever family's Grip
 * list holds the grip name. Shell fields (Slot, Class, ExilusPolarity,
 * CompatibilityTags, Family, Link, Image) come from the weapons-store
 * template entry "<Chamber> (Primary|Secondary)" whose own stats are
 * zeroed placeholders; Disposition comes from the chamber (the
 * template disagrees — Catchmoon template 0.75 vs chamber 0.5 — and
 * the chamber is the part source).
 *
 * Zaws (wiki "Zaw" page, "Final Stats" + "Grip" sections):
 *   "The final stats of a Zaw are the values of the Strike, Grip, and
 *   Link added together. When a value, namely damage, exists on a
 *   Strike but the Grip/Link value is a single scalar, it is
 *   distributed among the damage types proportionally to the Strike's
 *   damage ratio; for two-handed grips the damage is further
 *   multiplied by the Strike's two-handed damage factor."
 *   -> Damage types: strike types scaled by (strikeTotal + gripDmg +
 *      linkDmg) / strikeTotal, then x strike.Multi[handed].Base when
 *      TwoHanded. Speed (fire rate) = grip.Speed + strike.Speed +
 *      link.Speed. CritChance = strike + link; StatusChance = strike +
 *      link; CritMultiplier = strike only. Weapon Class =
 *      strike.Type[grip.Type] (OneHanded | TwoHanded).
 *
 * Amps (wiki "Amp" page, "Components"): "The Prism is the main
 * component... provides the primary fire mode"; "the Scaffold provides
 * an alternate fire mode"; "the Brace... applies a stat boost to the
 * amp, changing the energy pool, recharge rate, recharge delay and/or
 * critical/status chance". Prism/scaffold parts ARE weapons-store
 * entries (Slot 'Amp'); braces are in NO store — their modifiers come
 * from data/derived/amp_braces.json (extracted from the Amp page's
 * component table; crit/status braces add percentage POINTS to both
 * attacks). Assembled energy pool = prism Magazine (100) + brace
 * energyPool; recharge delay/rate likewise.
 *
 * MOA bodies (wiki "MOA (Companion)" page, "Stats"): "At base, a MOA
 * companion will have 350 health, 350 shields, and 350 armor...
 * components can add or subtract percentages." DEVIATION, verified:
 * the Modular store's Core/Gyro fractions are HALF the percentages in
 * the page's component table (Drex Core: store 5% Health vs table
 * +10%), and the page's own published stat ranges (Health 367-473,
 * Shields 315-438, Armor 350-438) plus its invariant "the sum of all
 * stats of a MOA always adds up to 1190" reproduce EXACTLY with the
 * doubled values and NOT with the raw store fractions — so assembly
 * uses stat = 350 x (1 + 2 x (coreFrac + gyroFrac)) per stat.
 * Brackets: the page's Bracket section states every bracket carries
 * four Penjaga polarities plus the one the store lists ('None' =
 * none). Models contribute precepts only.
 *
 * Hounds (wiki "Hound (Companion)" pages): final stat = Core absolute
 * value x (1 + Bracket fraction) per stat — here the store fractions
 * DO match the page galleries exactly (Zubb: -5% Health / +10%
 * Shield / +15% Armor). Stabilizers carry the polarities (+ a
 * precept); models carry the weapon + a precept.
 */
'use strict';

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function round2(x) { return Math.round(x * 100) / 100; }

var AMP_ARCANE_SLOTS = 2;      // wiki "Arcane Enhancement", Application:
var OPERATOR_ARCANE_SLOTS = 2; // "A total of two Arcanes can be equipped
                               // on each Warframe, Operator, and
                               // Operator Amps" (weapons: one).

function getModular(data) {
  var m = data && data.modular;
  if (!m || !m.Zaw) {
    var alt = data && data.raw && data.raw.Modular;
    if (alt) return alt;
    throw new Error('modular.js: data.modular (Module:Modular/data) missing');
  }
  return m;
}
function getWeapons(data) {
  var w = data && data.weapons;
  if (!w) throw new Error('modular.js: data.weapons (weapons store) missing');
  return w.Weapon || w; // tolerate {Weapon: {...}} or a flat map
}

function perGrip(field, gripName) {
  if (field && typeof field === 'object') return field[gripName];
  return field;
}

// ---- Kitguns ---------------------------------------------------------------
function assembleKitgun(data, chamberName, gripName, loaderName) {
  var mod = getModular(data);
  var weapons = getWeapons(data);
  var family = null;
  ['KitgunPrimary', 'KitgunSecondary'].forEach(function (f) {
    if (mod[f] && mod[f].Grip && mod[f].Grip[gripName]) family = f;
  });
  if (!family) throw new Error('assembleKitgun: unknown grip "' + gripName + '" (in neither Kitgun family)');
  var fam = mod[family];
  var ch = fam.Chamber[chamberName];
  var lo = fam.Loader[loaderName];
  if (!ch) throw new Error('assembleKitgun: unknown chamber "' + chamberName + '" for ' + family);
  if (!lo) throw new Error('assembleKitgun: unknown loader "' + loaderName + '"');
  var primary = family === 'KitgunPrimary';
  var tmpl = weapons[chamberName + (primary ? ' (Primary)' : ' (Secondary)')] || {};

  var attack = {
    AttackName: 'Normal Attack',
    AttackIndex: 1,
    Damage: deepClone(perGrip(ch.Damage, gripName) || {}),
    CritChance: (ch.CritChance || 0) + (lo.CritChance || 0),
    CritMultiplier: (ch.CritMultiplier || 0) + (lo.CritMultiplier || 0),
    StatusChance: (ch.StatusChance || 0) + (lo.StatusChance || 0),
    FireRate: perGrip(ch.FireRate, gripName),
    Multishot: typeof ch.Multishot === 'number' ? ch.Multishot : 1,
    ShotType: ch.ShotType || null,
    Range: perGrip(ch.Range, gripName),
    Falloff: deepClone(ch.Falloff || null),
    MaxSpread: ch.MaxSpread, MinSpread: ch.MinSpread,
    Accuracy: ch.Accuracy,
    PunchThrough: ch.PunchThrough || 0,
    ForcedProcs: (ch.ForcedProcs || []).slice(),
    AmmoCost: ch.AmmoCost || 1
  };
  return {
    Name: chamberName + (primary ? ' (Primary)' : ' (Secondary)'),
    Slot: primary ? 'Primary' : 'Secondary',
    Class: tmpl.Class || (primary ? 'Rifle' : 'Pistol'),
    Trigger: ch.Trigger || tmpl.Trigger || null,
    Attacks: [attack],
    Magazine: (ch.Magazine || {})[lo.Magazine],
    Reload: lo.Reload,
    AmmoMax: ch.AmmoMax, AmmoPickup: ch.AmmoPickup,
    Disposition: ch.Disposition,
    ExilusPolarity: tmpl.ExilusPolarity || null,
    CompatibilityTags: (tmpl.CompatibilityTags || []).slice(),
    Family: tmpl.Family || chamberName,
    Link: tmpl.Link, Image: tmpl.Image,
    MaxRank: 30,
    Modular: true,
    ModularParts: { chamber: chamberName, grip: gripName, loader: loaderName, family: family }
  };
}

// ---- Zaws ------------------------------------------------------------------
function assembleZaw(data, strikeName, gripName, linkName) {
  var mod = getModular(data);
  var weapons = getWeapons(data);
  var z = mod.Zaw;
  var st = z.Strike[strikeName], gr = z.Grip[gripName], li = z.Link[linkName];
  if (!st) throw new Error('assembleZaw: unknown strike "' + strikeName + '"');
  if (!gr) throw new Error('assembleZaw: unknown grip "' + gripName + '"');
  if (!li) throw new Error('assembleZaw: unknown link "' + linkName + '"');
  var handed = gr.Type; // 'OneHanded' | 'TwoHanded'
  var strikeTotal = 0;
  Object.keys(st.Damage || {}).forEach(function (k) { strikeTotal += st.Damage[k]; });
  var addScalar = (gr.Damage || 0) + (li.Damage || 0);
  var scale = strikeTotal > 0 ? (strikeTotal + addScalar) / strikeTotal : 1;
  var factor = 1;
  if (handed === 'TwoHanded' && st.Multi && st.Multi.TwoHanded) {
    factor = st.Multi.TwoHanded.Base || 1;
  }
  var dmg = {};
  Object.keys(st.Damage || {}).forEach(function (k) { dmg[k] = st.Damage[k] * scale * factor; });
  var tmpl = weapons[strikeName] || {};
  var attack = {
    AttackName: 'Normal Attack',
    AttackIndex: 1,
    Damage: dmg,
    CritChance: (st.CritChance || 0) + (li.CritChance || 0),
    CritMultiplier: st.CritMultiplier || 0,
    StatusChance: (st.StatusChance || 0) + (li.StatusChance || 0),
    FireRate: (gr.Speed || 0) + (st.Speed || 0) + (li.Speed || 0)
  };
  return {
    Name: strikeName,
    Slot: 'Melee',
    Class: (st.Type || {})[handed] || tmpl.Class || 'Melee',
    Attacks: [attack],
    Disposition: st.Disposition,
    CompatibilityTags: (tmpl.CompatibilityTags || []).slice(),
    Family: tmpl.Family || strikeName,
    Link: tmpl.Link, Image: tmpl.Image,
    MaxRank: 30,
    Modular: true,
    ModularParts: { strike: strikeName, grip: gripName, link: linkName, handed: handed },
    Multi: st.Multi ? deepClone(st.Multi[handed] || null) : null
  };
}

// ---- Amps ------------------------------------------------------------------
function assembleAmp(data, prismName, scaffoldName, braceName) {
  var weapons = getWeapons(data);
  var P = weapons[prismName], S = weapons[scaffoldName];
  if (!P || P.Slot !== 'Amp') throw new Error('assembleAmp: "' + prismName + '" is not an Amp part in the weapons store');
  if (!S || S.Slot !== 'Amp') throw new Error('assembleAmp: "' + scaffoldName + '" is not an Amp part in the weapons store');
  if (!/Prism/.test(prismName)) throw new Error('assembleAmp: prism must be a Prism part, got "' + prismName + '"');
  if (!/Scaffold/.test(scaffoldName)) throw new Error('assembleAmp: scaffold must be a Scaffold part, got "' + scaffoldName + '"');
  var braceRec = ((data.braces && data.braces.braces) || {})[braceName];
  if (!braceRec) throw new Error('assembleAmp: unknown brace "' + braceName + '" (data/derived/amp_braces.json)');
  var attacks = [];
  [P, S].forEach(function (part) {
    (part.Attacks || []).forEach(function (a) {
      var na = deepClone(a);
      na.AttackIndex = attacks.length + 1;
      na.CritChance = (na.CritChance || 0) + (braceRec.critChance || 0);
      na.StatusChance = (na.StatusChance || 0) + (braceRec.statusChance || 0);
      attacks.push(na);
    });
  });
  return {
    Name: prismName + ' + ' + scaffoldName + ' + ' + braceName,
    Slot: 'Amp',
    Class: 'Amp',
    Attacks: attacks,
    Magazine: (P.Magazine || 0) + (braceRec.energyPool || 0), // energy pool
    Reload: P.Reload,                                        // recharge time
    ReloadDelay: (P.ReloadDelay || 0) + (braceRec.rechargeDelay || 0),
    ReloadRate: (P.ReloadRate || 0) + (braceRec.rechargeRate || 0),
    MaxRank: 30,
    Modular: true,
    ModularParts: { prism: prismName, scaffold: scaffoldName, brace: braceName }
  };
}

// ---- MOA / Hound bodies ------------------------------------------------------
// See the header: the MOA store fractions are half the page's values;
// the page's ranges + the 1190 invariant verify the doubling.
var MOA_BASE = 350;
var MOA_STORE_SCALE = 2;

function assembleMOA(data, modelName, coreName, gyroName, bracketName) {
  var mod = getModular(data);
  var fam = mod.MOA;
  var model = fam.Model[modelName], core = fam.Core[coreName],
      gyro = fam.Gyro[gyroName], bracket = fam.Bracket[bracketName];
  if (!model) throw new Error('assembleMOA: unknown model "' + modelName + '"');
  if (!core) throw new Error('assembleMOA: unknown core "' + coreName + '"');
  if (!gyro) throw new Error('assembleMOA: unknown gyro "' + gyroName + '"');
  if (!bracket) throw new Error('assembleMOA: unknown bracket "' + bracketName + '"');
  function stat(k) {
    return MOA_BASE * (1 + MOA_STORE_SCALE * ((core[k] || 0) + (gyro[k] || 0)));
  }
  var pols = ['Penjaga', 'Penjaga', 'Penjaga', 'Penjaga']; // page, Bracket section
  (bracket.Polarities || []).forEach(function (p) { if (p && p !== 'None') pols.push(p); });
  return {
    Name: modelName + ' Moa',
    Type: 'MOA',
    Category: 'Pets',
    Health: stat('Health'),
    Shield: stat('Shield'),
    Armor: stat('Armor'),
    Polarities: pols,
    Precepts: (model.Precepts || []).slice(),
    Modular: true,
    ModularParts: { model: modelName, core: coreName, gyro: gyroName, bracket: bracketName }
  };
}

function assembleHound(data, modelName, coreName, bracketName, stabilizerName) {
  var mod = getModular(data);
  var fam = mod.Hound;
  var model = fam.Model[modelName], core = fam.Core[coreName],
      bracket = fam.Bracket[bracketName], stab = fam.Stabilizer[stabilizerName];
  if (!model) throw new Error('assembleHound: unknown model "' + modelName + '"');
  if (!core) throw new Error('assembleHound: unknown core "' + coreName + '"');
  if (!bracket) throw new Error('assembleHound: unknown bracket "' + bracketName + '"');
  if (!stab) throw new Error('assembleHound: unknown stabilizer "' + stabilizerName + '"');
  function stat(k) { return (core[k] || 0) * (1 + (bracket[k] || 0)); }
  return {
    Name: modelName + ' Hound',
    Type: 'Hound',
    Category: 'Pets',
    Health: stat('Health'),
    Shield: stat('Shield'),
    Armor: stat('Armor'),
    Polarities: (stab.Polarities || []).slice(),
    Weapon: (model.Weapons || [])[0] || null,
    Precepts: (model.Precepts || []).concat(bracket.Precepts || [], stab.Precepts || []),
    Modular: true,
    ModularParts: { model: modelName, core: coreName, bracket: bracketName, stabilizer: stabilizerName }
  };
}

// ---- Amp arcane solve --------------------------------------------------------
// Amps take no mods: the solve picks up to AMP_ARCANE_SLOTS Amp-type
// and OPERATOR_ARCANE_SLOTS Operator-type arcanes from the full pool,
// at max rank (project convention), scored like the other solvers:
// At-least shortfall first, then Closest distance, then fewest pieces.
// Forward model (paper stats) over the chosen attack:
//   damagePct      -> total damage x (1 + sum/100)
//   critPct        -> crit chance x (1 + sum/100)   (relative, as in game)
//   critDmgPct     -> crit multiplier x (1 + sum/100); unit 'multiplier'
//                     in the data converts as (x-1)*100 first
//   statusPct      -> status chance x (1 + sum/100)
//   fireRatePct    -> fire rate x (1 + sum/100)
//   multishotPct   -> multishot x (1 + sum/100)
//   convert        -> moves value% of the fromElement damage into the
//                     target element (composition changes; total does not)
// Conditional arcanes/effects count only when routes.conditional is on.
// Stats: damage, damageByType, critChance, critMultiplier,
// statusChance, fireRate, multishot.
var AMP_STAT_OF_EFFECT = {
  damagePct: 'damageScale', critPct: 'critScale', critDmgPct: 'critDmgScale',
  statusPct: 'statusScale', fireRatePct: 'fireRateScale', multishotPct: 'multishotScale'
};

function ampBase(input) {
  var amp = input.amp;
  if (!amp || !amp.Attacks || !amp.Attacks.length) {
    throw new Error('solveAmp: input.amp must be an assembled amp (assembleAmp) with Attacks');
  }
  var idx = typeof input.attackIndex === 'number' ? input.attackIndex : 0;
  var atk = amp.Attacks[idx];
  if (!atk) throw new Error('solveAmp: attackIndex ' + idx + ' out of range');
  var dmg = {};
  var total = 0;
  Object.keys(atk.Damage || {}).forEach(function (k) { dmg[k] = atk.Damage[k]; total += atk.Damage[k]; });
  return {
    attack: atk, damageByType: dmg, damage: total,
    critChance: atk.CritChance || 0, critMultiplier: atk.CritMultiplier || 0,
    statusChance: atk.StatusChance || 0, fireRate: atk.FireRate || 0,
    multishot: typeof atk.Multishot === 'number' ? atk.Multishot : 1
  };
}

function ampForward(base, chosenEffects) {
  var dmg = deepClone(base.damageByType);
  var scale = { damageScale: 0, critScale: 0, critDmgScale: 0, statusScale: 0, fireRateScale: 0, multishotScale: 0 };
  chosenEffects.forEach(function (e) {
    if (e.stat === 'convert') {
      var from = dmg[e.fromElement] || 0;
      var moved = from * (e.value / 100);
      dmg[e.fromElement] = from - moved;
      dmg[e.element] = (dmg[e.element] || 0) + moved;
      return;
    }
    var key = AMP_STAT_OF_EFFECT[e.stat];
    if (!key) return;
    var v = e.unit === 'multiplier' ? (e.value - 1) * 100 : e.value;
    scale[key] += v;
  });
  var total = 0;
  Object.keys(dmg).forEach(function (k) { total += dmg[k]; });
  return {
    damage: round2(total * (1 + scale.damageScale / 100)),
    damageByType: dmg,
    critChance: round2(base.critChance * (1 + scale.critScale / 100)),
    critMultiplier: round2(base.critMultiplier * (1 + scale.critDmgScale / 100)),
    statusChance: round2(base.statusChance * (1 + scale.statusScale / 100)),
    fireRate: round2(base.fireRate * (1 + scale.fireRateScale / 100)),
    multishot: round2(base.multishot * (1 + scale.multishotScale / 100))
  };
}

function solveAmp(input, data) {
  var routes = input.routes || {};
  var conditional = !!routes.conditional;
  var targets = input.targets || {};
  var targetedStats = Object.keys(targets).filter(function (s) {
    return targets[s] && targets[s].mode !== 'dontcare' && typeof targets[s].value === 'number';
  });
  var base = ampBase(input);
  var pool = ((data.arcaneEffects && data.arcaneEffects.arcanes) || []);

  function candidate(entry) {
    // Returns the entry's usable effects for amp stats, or null.
    if (entry.conditional && !conditional) return null;
    var effs = (entry.effects || []).filter(function (e) {
      if (typeof e.value !== 'number') return false;
      if (e.conditional && !conditional) return false;
      if (e.stat === 'convert') return false; // composition only; cannot move a targeted total
      return !!AMP_STAT_OF_EFFECT[e.stat];
    });
    if (!effs.length) return null;
    if (!effs.some(function (e) { return targetedStats.indexOf(ampTargetStat(e)) >= 0; })) return null;
    return { name: entry.name, effects: effs };
  }
  function ampTargetStat(e) {
    return { damageScale: 'damage', critScale: 'critChance', critDmgScale: 'critMultiplier',
             statusScale: 'statusChance', fireRateScale: 'fireRate', multishotScale: 'multishot' }[AMP_STAT_OF_EFFECT[e.stat]];
  }
  var ampCands = pool.filter(function (a) { return a.type === 'Amp'; }).map(candidate).filter(Boolean);
  var opCands = pool.filter(function (a) { return a.type === 'Operator'; }).map(candidate).filter(Boolean);

  function subsets(cands, max) {
    var out = [[]];
    for (var i = 0; i < cands.length; i++) {
      out.push([cands[i]]);
      for (var j = i + 1; j < cands.length && max >= 2; j++) out.push([cands[i], cands[j]]);
    }
    return out;
  }
  function score(achieved, pieces) {
    var shortfall = 0, closestDist = 0;
    targetedStats.forEach(function (stat) {
      var t = targets[stat];
      var a = achieved[stat];
      if (typeof a !== 'number') return;
      if (t.mode === 'atleast') { if (a < t.value) shortfall += (t.value - a) / t.value; }
      else if (t.mode === 'closest') closestDist += Math.abs(a - t.value) / Math.max(1, Math.abs(t.value));
    });
    return { score: shortfall * 10000 + closestDist * 100 + pieces * 0.01, shortfall: shortfall, closestDist: closestDist };
  }
  var best = null;
  subsets(ampCands, AMP_ARCANE_SLOTS).forEach(function (as) {
    subsets(opCands, OPERATOR_ARCANE_SLOTS).forEach(function (os) {
      var effs = [];
      as.concat(os).forEach(function (c) { effs = effs.concat(c.effects); });
      var achieved = ampForward(base, effs);
      var sc = score(achieved, as.length + os.length);
      if (!best || sc.score < best.sc.score) {
        best = { sc: sc, achieved: achieved, amp: as.map(function (c) { return c.name; }),
                 operator: os.map(function (c) { return c.name; }) };
      }
    });
  });
  var unmet = [];
  targetedStats.forEach(function (stat) {
    var t = targets[stat];
    if (t.mode === 'atleast' && best.achieved[stat] < t.value - 1e-9) {
      unmet.push({ stat: stat, target: t.value, achieved: best.achieved[stat] });
    }
  });
  var notes = ['Amp solve: no mods exist for Amps — the solve picks up to ' +
    AMP_ARCANE_SLOTS + ' Amp arcanes and ' + OPERATOR_ARCANE_SLOTS +
    ' Operator arcanes at max rank (slot counts: wiki "Arcane ' +
    'Enhancement", Application).'];
  if (!conditional) notes.push('Conditional arcanes are excluded (conditional route off).');
  unmet.forEach(function (u) {
    notes.push('Target ' + u.stat + ' ' + u.target + ' was not reached; ' +
      u.achieved + ' is the best the parsed arcane pool offers.');
  });
  return {
    achieved: best.achieved,
    arcanes: { amp: best.amp, operator: best.operator },
    unmetTargets: unmet,
    notes: notes
  };
}

var Modular = {
  assembleKitgun: assembleKitgun,
  assembleZaw: assembleZaw,
  assembleAmp: assembleAmp,
  assembleMOA: assembleMOA,
  assembleHound: assembleHound,
  solveAmp: solveAmp,
  AMP_ARCANE_SLOTS: AMP_ARCANE_SLOTS,
  OPERATOR_ARCANE_SLOTS: OPERATOR_ARCANE_SLOTS,
  _internal: { ampForward: ampForward, ampBase: ampBase, MOA_STORE_SCALE: MOA_STORE_SCALE }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Modular;
if (typeof window !== 'undefined') window.Modular = Modular;
