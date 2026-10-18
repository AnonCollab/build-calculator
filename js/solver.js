/*
 * solver.js — Warframe build solver core v1 (ability / survival stats).
 *
 * Plain JavaScript, no dependencies. Runs in the browser (window.Solver)
 * and under Node for tests (module.exports guard at the bottom).
 *
 * Scope v1: Warframe ability stats (strength/duration/range/efficiency)
 * and flat pools (health/shield/armor/energy max). Sources: mods (8 slots,
 * partial ranks; plus 1 exilus slot when the exilus route is on), aura
 * (1 slot), arcanes (2 slots, curated layer), Archon Shards (5 slots,
 * wallet + fusion), Tome invocations (cross-gear, 1 pick), legacy Arcane
 * Helmets (1 pick from the frame's helmet list, route toggle DEFAULT OFF).
 *
 * Data is passed in as a bundle — this file contains no game data:
 *   data = {
 *     modsEffects:    data/derived/mods_effects.json    ({mods:[...]})
 *     arcaneEffects:  data/derived/arcane_effects_full.json ({arcanes:[...]})
 *                     (the full pattern-parsed pool; the 3 verified
 *                      curated entries ride inside it with precedence.
 *                      The curated file alone also works as a bundle.)
 *     tomeEffects:    data/derived/tome_effects.json    ({mods:[...]})
 *     auraEffects:    data/derived/aura_effects.json    ({mods:[...]})
 *     shardEffects:   data/derived/shard_effects.json  ({colours:{...}})
 *     setBonuses:     data/derived/set_bonuses.json     ({sets:{...}})
 *                     (optional — missing means set bonuses are counted
 *                      from mod records but reported as unknown)
 *     warframes:      data/raw/warframes_data.json      ({Warframes:{...},
 *                      Necramechs:{...}}) — itemKind 'necramech' solves
 *                      use the Necramechs entries + the Necramech mod pool
 *     companions:     data/raw/companions_data.json     ({Companions:{...}})
 *                      — itemKind 'companion' solves (10 slots, pool =
 *                      Companion/Type/Name/breed mod types; MOA/Hound
 *                      entries carry no base stats in the store and a
 *                      store-only solve is rejected with an explicit
 *                      error — since S3 they solve via
 *                      input.companionEntry assembled by modular.js)
 *     linkEffects:    data/derived/link_effects.json    ({mods:[...]})
 *                      — companion Link mods; materialised against
 *                      input.ownerStats {health, shield, armor} (the
 *                      OWNER Warframe's stats) at solve time
 *     helminth:       data/derived/helminth.json        ({subsumes:[...]})
 *                      — Stage S3: subsumable abilities + diminished
 *                      text; only entries with structured `effects`
 *                      (Defy, Brightbonnet) enter the search. Input:
 *                      routes.helminth (default OFF) + abilityLocks
 *                      [bool x4] aligned with the frame's Abilities
 *                      list (true = locked, never replaced). At most
 *                      one subsume; the donor frame's own ability is
 *                      never offered (base-name family match).
 *                      Companion solves may pass input.companionEntry
 *                      (an assembled entry from modular.js) to override
 *                      the store lookup — how MOA/Hound bodies solve.
 *     legacyHelmets:  data/derived/legacy_helmets.json
 *                     { frameName: [ {helmetName, effects:[{stat,statText,
 *                       value,unit}]}, ... ] }
 *                     (frame -> LIST of helmets; optional — missing/empty
 *                      means "no helmets available". Effects with stat:null
 *                      are out-of-scope stats: ignored for stat purposes,
 *                      the helmet stays choosable for its mapped effects)
 *   }
 *
 * Documented simplifications / deviations (see BUILD_LOG for the full list):
 *  - Rank candidates per mod are pruned to {maxRank} plus the ranks that
 *    bracket each targeted stat's initial gap (and the half-gap rank).
 *  - Set bonuses: per-piece values parsed from the sets' bonus
 *    descriptions (data/derived/set_bonuses.json — the printed value is
 *    the PER-PIECE contribution, total = value x pieces; verified
 *    against the wiki's per-set tables). Pieces are counted across the
 *    focus item (mods in either slot kind + the aura pick) plus
 *    cross-gear support pieces passed in as input.supportSetPieces.
 *    Parsed bonuses that map to a solver stat are applied; the rest are
 *    counted and reported in result.setBonuses. Sets whose bonus text
 *    is prose (incl. the Umbral/Sacrificial "Enhance mods in this set."
 *    — the enhancement percentage is NOT in the source data) are never
 *    applied; using 2+ pieces of one earns an explicit "not modelled"
 *    note. The Umbral-enhancement scaling code path exists and activates
 *    only if a future dataset actually publishes enhanceModsPercent.
 *  - Tome Canticles are excluded: the derived data does not mark their
 *    target (e.g. Jahu reduces ENEMY armor — pairing it to the player's
 *    armor would corrupt results). Only stacking Invocations are used.
 *  - Exilus slot: when routes.exilus is on, ONE extra slot accepts only
 *    exilus-flagged mods (the derived record's `exilus` field, promoted
 *    from the raw store's IsExilus). Exilus-flagged mods may also occupy
 *    normal slots, with or without the route. The exilus slot has no
 *    innate polarity; Forma may polarise it within the same budget.
 *  - Capacity assignment is greedy (largest drain first, prefer polarity
 *    match) rather than a full assignment optimisation.
 *  - Umbra Forma: regular Forma cannot create an Umbra slot. The solver
 *    takes input.umbraForma (default 0); after the regular Forma pass,
 *    slots holding Umbra-polarity mods may be converted to Umbra with
 *    that separate budget. arrangement.umbraFormaUsed reports the spend
 *    and formaPlan entries for it carry umbra: true.
 *  - Cheapest variant: solve() re-runs the search with cost-dominant
 *    weights (fewest mods, then Forma, then shards), restricted to
 *    states meeting every At-least target the main result met and within
 *    0.05 of its Closest distance. result.cheapest is null when the
 *    cheapest arrangement is the main one.
 */
(function () {
  'use strict';

  // ---- stat mapping -------------------------------------------------------
  // upgradeType (wiki Module:Mods/data enums) -> solver stat key.
  // Ability stats are percent points over a base of 100. Pools are
  // final = base * (1 + sumPercent/100) + sumFlat.
  var UT_TO_STAT = {
    AVATAR_ABILITY_STRENGTH: 'abilityStrength',
    AVATAR_ABILITY_DURATION: 'abilityDuration',
    AVATAR_ABILITY_RANGE: 'abilityRange',
    AVATAR_ABILITY_EFFICIENCY: 'abilityEfficiency',
    AVATAR_HEALTH_MAX: 'health',
    AVATAR_SHIELD_MAX: 'shield',
    AVATAR_ARMOUR: 'armor',   // spelling used by the wiki data
    AVATAR_ARMOR: 'armor',    // defensive: US spelling, not present in data
    AVATAR_POWER_MAX: 'energyMax',   // energy max in the wiki enums
    AVATAR_ENERGY_MAX: 'energyMax'   // defensive: not present in data
  };
  var ABILITY_STATS = ['abilityStrength', 'abilityDuration', 'abilityRange', 'abilityEfficiency'];
  var POOL_STATS = ['health', 'shield', 'armor', 'energyMax'];
  var ALL_STATS = ABILITY_STATS.concat(POOL_STATS);

  // Shard bonus page-text -> solver stat key (only bonuses in solver scope).
  var SHARD_STAT_MAP = {
    'Ability Strength': 'abilityStrength',
    'Ability Duration': 'abilityDuration',
    'Max Health': 'health',
    'Shield Capacity': 'shield',
    'Energy Max': 'energyMax',
    'Armor': 'armor'
  };
  // Coalescent Fusion parents (DESIGN.md): 1 normal of each parent colour.
  var FUSED_PARENTS = {
    Violet: ['Crimson', 'Azure'],
    Topaz: ['Crimson', 'Amber'],
    Emerald: ['Amber', 'Azure']
  };

  var EFFICIENCY_CAP = 175; // game rule: ability efficiency caps at 175%

  // ---- fusion (ranking) costs ------------------------------------------------
  // Verified from the wiki "Fusion" page (Stage S2, 2026-10-18): Endo
  // base cost E_BC and Credits base cost Cr_BC by rarity; the cost from
  // rank 0 to rank R is base x (2^R - 1) for both. (The S2 brief's
  // guessed bases — Uncommon 15 / Rare 20 — were WRONG; the page says
  // Uncommon/Peculiar 20 and Rare/Amalgam/Riven/Galvanized 30, with
  // Legendary 40 confirmed by the 40,920-Endo Primed total. Antique
  // mods use their own much larger bases, also from the page.)
  var FUSION_ENDO = { Common: 10, Uncommon: 20, Rare: 30, Legendary: 40 };
  var FUSION_CREDITS = { Common: 483, Uncommon: 966, Rare: 1449, Legendary: 1932 };
  var FUSION_ENDO_ANTIQUE = { Common: 160, Uncommon: 320, Rare: 480 };
  var FUSION_CREDITS_ANTIQUE = { Common: 5000, Uncommon: 10000, Rare: 15000 };
  // Cost to rank a mod record from rank 0 to `rank`. Rank 0 costs 0.
  // Returns null when the record's rarity is outside the page's tables
  // (callers surface that honestly instead of guessing).
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
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---- data normalisation -------------------------------------------------
  // Convert one derived mod record to a solver pool record, or null when
  // it has no effect that maps to a solver stat. Shared by the Warframe,
  // Necramech and Companion pools (they differ only in which derived
  // Type(s) they admit).
  function modRecord(ctx, m) {
    if (m.parseStatus !== 'clean' && m.parseStatus !== 'partial') return null;
    var effs = [];
    (m.effects || []).forEach(function (e) {
      var stat = UT_TO_STAT[e.upgradeType];
      if (!stat) {
        if (e.upgradeType && e.upgradeType.indexOf('AVATAR_') === 0) {
          ctx.unmappedUpgradeTypes[e.upgradeType] = true;
        }
        return;
      }
      if (e.unit !== 'percent' && e.unit !== 'flat') return;
      effs.push({
        stat: stat,
        unit: e.unit,
        valuePerRank: (typeof e.valuePerRank === 'number')
          ? e.valuePerRank
          : e.value / ((m.maxRank || 0) + 1),
        condition: e.condition || null
      });
    });
    if (!effs.length) return null;
    return {
      name: m.name,
      type: m.type || null,
      polarity: m.polarity || null,
      baseDrain: m.baseDrain || 0,
      rarity: m.rarity || null,
      maxRank: m.maxRank || 0,
      incompatible: m.incompatible || [],
      set: m.set || null,
      exilus: !!m.exilus,
      effects: effs
    };
  }

  function poolFromTypes(ctx, mods, types) {
    var pool = [], byName = {};
    mods.forEach(function (m) {
      if (!types[m.type]) return;
      var rec = modRecord(ctx, m);
      if (!rec) return;
      pool.push(rec);
      byName[rec.name] = rec;
    });
    return { pool: pool, byName: byName };
  }

  // Companion mod pool for one companion entry: the universal Companion
  // type, the companion's own Type and breed Name types, Beast mods for
  // pets, Sentinel/Robotic/MOA/Hound mod types for the robotic lines —
  // plus the Link mods, materialised against the owner's stats (a Link
  // mod's effect is percent-of-owner as a FLAT pool bonus; with no
  // ownerStats supplied the value is 0 and the solve says so).
  function buildCompanionPool(ctx, entry, ownerStats) {
    var types = { Companion: 1 };
    if (entry.Type) types[entry.Type] = 1;
    if (entry.Name) types[entry.Name] = 1;
    if (entry.Category === 'Sentinels') { types.Sentinel = 1; types.Robotic = 1; }
    if (entry.Type === 'MOA') { types.MOA = 1; types.Robotic = 1; }
    if (entry.Type === 'Hound') { types.Hound = 1; types.Robotic = 1; }
    if (entry.Category === 'Pets') types.Beast = 1;
    var built = poolFromTypes(ctx, ctx.derivedMods, types);
    ctx.linkMods.forEach(function (lm) {
      var ownerVal = ownerStats ? (ownerStats[lm.ownerStat] || 0) : 0;
      var rec = {
        name: lm.name, type: lm.type || 'Companion',
        polarity: lm.polarity || null, baseDrain: lm.baseDrain || 0,
        rarity: lm.rarity || null, maxRank: lm.maxRank || 0,
        incompatible: [], set: null, exilus: false, isLink: true,
        effects: [{
          stat: lm.ownerStat, unit: 'flat',
          valuePerRank: ownerVal * lm.valuePerRank / 100, condition: null
        }]
      };
      built.pool.push(rec);
      built.byName[rec.name] = rec;
    });
    return built;
  }

  function buildContext(data) {
    var ctx = { unmappedUpgradeTypes: {} };

    var wf = (data.warframes && data.warframes.Warframes) || {};
    ctx.frames = wf;
    ctx.necramechs = (data.warframes && data.warframes.Necramechs) || {};
    ctx.companions = (data.companions && data.companions.Companions) || {};
    ctx.linkMods = (data.linkEffects && data.linkEffects.mods) || [];
    // Helminth subsumes (Stage S3): only dataset entries whose effects
    // were structured from their diminished text enter the search;
    // effects-null entries stay data-only (see extract_helminth.py).
    ctx.helminth = ((data.helminth && data.helminth.subsumes) || []).filter(function (e) {
      return e && e.ability && Array.isArray(e.effects) && e.effects.length;
    });

    // Mod pools by item kind: Warframe-type mods for frames, Necramech-
    // type for Necramechs (companion pools are built per-solve, since
    // they depend on the companion entry and the owner's stats).
    var mods = (data.modsEffects && data.modsEffects.mods) || [];
    ctx.derivedMods = mods;
    var wfPool = poolFromTypes(ctx, mods, { Warframe: 1 });
    ctx.modPool = wfPool.pool;
    ctx.modByName = wfPool.byName;
    var mechPool = poolFromTypes(ctx, mods, { Necramech: 1 });
    ctx.necramechPool = mechPool.pool;
    ctx.necramechByName = mechPool.byName;

    // name -> set for EVERY derived mod (incl. Aura/Tome/companion
    // types), so set-piece counting can also see the aura pick and any
    // other single pick by name.
    ctx.setOfMod = {};
    mods.forEach(function (m) { if (m.set) ctx.setOfMod[m.name] = m.set; });

    // Arcanes: effects already use solver stat keys. Non-numeric
    // values (unbounded per-stack parses from the full pool) are
    // dropped — the solver cannot count what the text cannot bound.
    ctx.arcanes = ((data.arcaneEffects && data.arcaneEffects.arcanes) || []).map(function (a) {
      return {
        name: a.name,
        conditional: !!a.conditional,
        effects: (a.effects || []).filter(function (e) {
          return ALL_STATS.indexOf(e.stat) >= 0 && typeof e.value === 'number';
        })
      };
    }).filter(function (a) { return a.effects.length; });

    // Tome mods: stacking Invocations only (see header note on Canticles).
    ctx.tomes = [];
    ((data.tomeEffects && data.tomeEffects.mods) || []).forEach(function (t) {
      (t.effects || []).forEach(function (e) {
        if (typeof e.perStackValue !== 'number' || typeof e.maxStacks !== 'number') return;
        var stat = UT_TO_STAT[e.upgradeType];
        if (!stat) return;
        ctx.tomes.push({
          name: t.name,
          stat: stat,
          total: e.perStackValue * e.maxStacks, // values are max-rank values
          conditional: true // stacking alt-fire buff, 20s window
        });
      });
    });

    // Auras: effects via upgradeType or the extractor's mappedStat.
    var AURA_STAT_MAP = { ability_strength: 'abilityStrength' };
    ctx.auras = [];
    ((data.auraEffects && data.auraEffects.mods) || []).forEach(function (a) {
      var effs = [];
      (a.effects || []).forEach(function (e) {
        if (e.target && e.target !== 'squad' && e.target !== 'self') return;
        var stat = UT_TO_STAT[e.upgradeType] || AURA_STAT_MAP[e.mappedStat] || null;
        if (!stat || (e.unit !== 'percent' && e.unit !== 'flat')) return;
        effs.push({
          stat: stat, unit: e.unit, value: e.value,
          // a timed aura effect (e.g. Growing Power, 6s) only counts
          // under the conditional toggle.
          conditional: (e.durationSeconds != null)
        });
      });
      ctx.auras.push({
        name: a.name, polarity: a.polarity || null,
        baseDrain: a.baseDrain || 0, maxRank: a.maxRank || 0, effects: effs,
        set: ctx.setOfMod[a.name] || null
      });
    });
    ctx.auraByName = {};
    ctx.auras.forEach(function (a) { ctx.auraByName[a.name] = a; });

    // Shards: only bonuses that map into solver scope become picks.
    ctx.shardPicks = []; // {colour, stat, unit, normal, tauforged}
    var colours = (data.shardEffects && data.shardEffects.colours) || {};
    Object.keys(colours).forEach(function (colour) {
      (colours[colour].bonuses || []).forEach(function (b) {
        var stat = SHARD_STAT_MAP[b.stat];
        if (!stat) return;
        ctx.shardPicks.push({
          colour: colour, stat: stat, unit: b.unit,
          normal: b.normal, tauforged: b.tauforged
        });
      });
    });

    // Set bonuses (data/derived/set_bonuses.json, optional): per-piece
    // values parsed from the sets' bonus descriptions by
    // pipeline/extract_set_bonuses.py. 'prose' / 'prose-enhance' sets
    // carry no usable number and are never applied — only counted and
    // reported (see setBonusReport in solve()).
    ctx.setBonuses = {};
    var sbData = (data.setBonuses && data.setBonuses.sets) || {};
    Object.keys(sbData).forEach(function (name) {
      var s = sbData[name] || {};
      ctx.setBonuses[name] = {
        perPiece: Array.isArray(s.perPiece) ? s.perPiece : null,
        enhanceModsPercent: (typeof s.enhanceModsPercent === 'number')
          ? s.enhanceModsPercent : null,
        parseStatus: s.parseStatus || 'prose',
        sourceText: s.sourceText || '',
        numUpgradesInSet: s.numUpgradesInSet || null
      };
    });

    // Legacy Arcane Helmets (optional dataset; may be missing entirely).
    // Real shape: frame -> LIST of helmets (most frames have two). A
    // single-object entry is tolerated and wrapped. Effects with stat:null
    // (out-of-scope stats) are dropped here — they cannot move a solver
    // stat — while the helmet remains choosable for its mapped effects.
    ctx.legacyHelmets = {};
    Object.keys(data.legacyHelmets || {}).forEach(function (frameName) {
      var entry = data.legacyHelmets[frameName];
      var list = Array.isArray(entry) ? entry : (entry ? [entry] : []);
      ctx.legacyHelmets[frameName] = list.filter(function (h) {
        return h && h.helmetName;
      }).map(function (h) {
        return {
          helmetName: h.helmetName,
          effects: (h.effects || []).filter(function (e) {
            return e && ALL_STATS.indexOf(e.stat) >= 0 &&
                   typeof e.value === 'number';
          }).map(function (e) {
            return {
              stat: e.stat, value: e.value,
              unit: e.unit === 'flat' ? 'flat' : 'percent'
            };
          })
        };
      });
    });

    return ctx;
  }

  // ---- wallet ---------------------------------------------------------------
  function initWallet(inputWallet) {
    var w = {};
    Object.keys(FUSED_PARENTS).concat(['Crimson', 'Amber', 'Azure']).forEach(function (c) {
      w[c] = { normal: 0, tauforged: 0 };
    });
    if (inputWallet) {
      Object.keys(inputWallet).forEach(function (c) {
        var e = inputWallet[c] || {};
        w[c] = { normal: e.normal || 0, tauforged: e.tauforged || 0 };
      });
    }
    return w;
  }
  function walletFlags(inputWallet, colour) {
    var e = (inputWallet && inputWallet[colour]) || {};
    return {
      ascent: !!e.canFuseAscent,
      coalescent: !!e.canFuseCoalescent
    };
  }

  // Try to spend one shard of (colour, tier) from wallet `w` (mutated copy
  // semantics: caller passes a clone). Returns fusion record or null on
  // success-as-stock, or false if the pick is not affordable.
  function spendShard(w, inputWallet, colour, tier) {
    var flags = walletFlags(inputWallet, colour);
    if (tier === 'normal') {
      if (w[colour] && w[colour].normal >= 1) { w[colour].normal -= 1; return null; }
      // Coalescent creation for fused colours: 1 normal of each parent.
      var parents = FUSED_PARENTS[colour];
      if (parents) {
        var allowed = flags.coalescent;
        if (!inputWallet || !inputWallet[colour]) {
          allowed = parents.every(function (p) { return walletFlags(inputWallet, p).coalescent; });
        }
        if (allowed && parents.every(function (p) { return w[p] && w[p].normal >= 1; })) {
          parents.forEach(function (p) { w[p].normal -= 1; });
          return { kind: 'coalescent', colour: colour, parents: parents.slice() };
        }
      }
      return false;
    }
    // tauforged
    if (w[colour] && w[colour].tauforged >= 1) { w[colour].tauforged -= 1; return null; }
    // Ascent Fusion: 3 normal of the same colour -> 1 tauforged.
    if (flags.ascent && w[colour] && w[colour].normal >= 3) {
      w[colour].normal -= 3;
      return { kind: 'ascent', colour: colour };
    }
    return false;
  }

  // ---- state ----------------------------------------------------------------
  function emptyState(inputWallet) {
    return {
      mods: {},        // name -> rank (the 8 normal slots)
      exilusMod: null, // {name, rank} in the exilus slot, or null
      aura: null,      // aura name
      arcanes: [],     // arcane names (max 2)
      shards: [],      // {colour, tier, stat, value, unit}
      tome: null,      // tome name
      helmet: null,    // legacy helmet name
      subsume: null,   // {ability, fromFrame, replacedAbility} (S3 Helminth)
      wallet: initWallet(inputWallet),
      fusions: []      // fusion records used to afford shard picks
    };
  }
  function stateSignature(s) {
    var mods = Object.keys(s.mods).sort().map(function (n) { return n + '@' + s.mods[n]; }).join(',');
    var ex = s.exilusMod ? s.exilusMod.name + '@' + s.exilusMod.rank : '';
    var shards = s.shards.map(function (x) { return x.colour + '/' + x.tier + '/' + x.stat; }).sort().join(',');
    var wal = Object.keys(s.wallet).sort().map(function (c) {
      return c + ':' + s.wallet[c].normal + '/' + s.wallet[c].tauforged;
    }).join(',');
    return [mods, ex, s.aura || '', s.arcanes.slice().sort().join(','), shards,
            s.tome || '', s.helmet || '', s.subsume ? s.subsume.ability : '',
            wal].join('|');
  }
  // Total mods placed (normal slots + exilus slot).
  function modCount(s) {
    return Object.keys(s.mods).length + (s.exilusMod ? 1 : 0);
  }

  // Set pieces for a state: focus pieces (mods in either slot kind,
  // plus the aura pick) + cross-gear support pieces supplied by the
  // caller as input.supportSetPieces {setName: count} (support gear is
  // already built — free placement, DESIGN.md Routes).
  function setPieceCounts(ctx, state, supportSetPieces) {
    var counts = {};
    function bump(set, kind) {
      if (!set) return;
      counts[set] = counts[set] || { focus: 0, support: 0 };
      counts[set][kind] += 1;
    }
    Object.keys(state.mods).forEach(function (n) { bump(ctx.setOfMod[n], 'focus'); });
    if (state.exilusMod) bump(ctx.setOfMod[state.exilusMod.name], 'focus');
    if (state.aura) bump(ctx.setOfMod[state.aura], 'focus');
    if (supportSetPieces) {
      Object.keys(supportSetPieces).forEach(function (set) {
        var n = supportSetPieces[set] | 0;
        if (n > 0) {
          counts[set] = counts[set] || { focus: 0, support: 0 };
          counts[set].support += n;
        }
      });
    }
    return counts;
  }

  // Sum a state's contributions: {stat: {percent, flat}}.
  function contributions(ctx, state, routes, supportSetPieces) {
    var sums = {};
    ALL_STATS.forEach(function (k) { sums[k] = { percent: 0, flat: 0 }; });
    var counts = setPieceCounts(ctx, state, supportSetPieces);
    function add(stat, unit, v) {
      if (!sums[stat]) return;
      if (unit === 'flat') sums[stat].flat += v; else sums[stat].percent += v;
    }
    function addModEffects(mod, rank) {
      if (!mod) return;
      // Umbral/Sacrificial-style enhancement: IF the dataset ever
      // publishes enhanceModsPercent, a set mod's own effects scale by
      // (1 + enhance% x (pieces-1)). With the current extraction the
      // value is null (the source text is prose), so this is inert and
      // such sets surface via the "not modelled" note instead.
      var scale = 1;
      var sb = mod.set ? ctx.setBonuses[mod.set] : null;
      if (sb && typeof sb.enhanceModsPercent === 'number') {
        var c = counts[mod.set];
        var pieces = c ? c.focus + c.support : 0;
        if (pieces > 1) scale = 1 + sb.enhanceModsPercent * (pieces - 1) / 100;
      }
      mod.effects.forEach(function (e) {
        if (e.condition && !routes.conditional) return;
        add(e.stat, e.unit, e.valuePerRank * (rank + 1) * scale);
      });
    }
    Object.keys(state.mods).forEach(function (name) {
      addModEffects(ctx.modByName[name], state.mods[name]);
    });
    if (state.exilusMod) {
      addModEffects(ctx.modByName[state.exilusMod.name], state.exilusMod.rank);
    }
    state.arcanes.forEach(function (name) {
      var a = ctx.arcanes.filter(function (x) { return x.name === name; })[0];
      if (!a) return;
      if (a.conditional && !routes.conditional) return;
      a.effects.forEach(function (e) { add(e.stat, e.unit, e.value); });
    });
    if (state.tome) {
      var t = ctx.tomes.filter(function (x) { return x.name === state.tome; })[0];
      if (t && (!t.conditional || routes.conditional)) add(t.stat, 'percent', t.total);
    }
    if (state.aura) {
      var au = ctx.auraByName[state.aura];
      if (au) au.effects.forEach(function (e) {
        if (e.conditional && !routes.conditional) return;
        add(e.stat, e.unit, e.value);
      });
    }
    state.shards.forEach(function (sh) { add(sh.stat, sh.unit, sh.value); });
    // Parsed set bonuses that map to a solver stat apply per piece
    // (focus + support). Bonuses that don't map (Augur conversion,
    // Proton/Boreal damage-taken, Gladiator crit-per-combo, ...) are
    // mechanics, not stats — setBonusReport surfaces them instead.
    Object.keys(counts).forEach(function (set) {
      var sb2 = ctx.setBonuses[set];
      if (!sb2 || !sb2.perPiece) return;
      var total = counts[set].focus + counts[set].support;
      if (total < 1) return;
      sb2.perPiece.forEach(function (pp) {
        var stat = UT_TO_STAT[pp.upgradeType];
        if (!stat) return;
        add(stat, pp.unit === 'flat' ? 'flat' : 'percent', pp.value * total);
      });
    });
    // Helminth subsume (S3): modelled effects from the dataset apply
    // like other sources. Conditional effects count only under the
    // conditional route; an effect whose scaling is 'abilityStrength'
    // scales with the strength sum from all OTHER sources (this block
    // runs after mods/arcanes/shards/set bonuses, so `sums` here
    // excludes the subsume itself). The dataset's two modelled entries
    // are both scaling 'flat'; the strength path exists for future data.
    if (state.subsume) {
      var sub = null;
      for (var si = 0; si < ctx.helminth.length; si++) {
        if (ctx.helminth[si].ability === state.subsume.ability) { sub = ctx.helminth[si]; break; }
      }
      if (sub) {
        sub.effects.forEach(function (e) {
          if (e.conditional && !routes.conditional) return;
          var v = e.value;
          if (e.scaling === 'abilityStrength') {
            v = v * (100 + sums.abilityStrength.percent) / 100;
          }
          add(e.stat, e.unit, v);
        });
      }
    }

    if (state.helmet) {
      // The dataset maps frame -> LIST of helmets; find the worn one.
      var helmList = ctx.legacyHelmets[state._helmetFrame] || [];
      var helm = null;
      helmList.forEach(function (h) { if (h.helmetName === state.helmet) helm = h; });
      if (helm) helm.effects.forEach(function (e) {
        add(e.stat, e.unit, e.value);
      });
    }
    return sums;
  }

  function achievedFrom(ctx, frame, sums) {
    var out = {};
    ABILITY_STATS.forEach(function (k) { out[k] = 100 + sums[k].percent; });
    out.abilityEfficiency = Math.min(EFFICIENCY_CAP, out.abilityEfficiency);
    POOL_STATS.forEach(function (k) {
      var baseKey = { health: 'Health', shield: 'Shield', armor: 'Armor', energyMax: 'Energy' }[k];
      var base = frame[baseKey] || 0;
      out[k] = base * (1 + sums[k].percent / 100) + sums[k].flat;
    });
    return out;
  }

  // ---- capacity / forma fitting ----------------------------------------------
  function auraCapacityBonus(ctx, frame, auraName) {
    if (!auraName) return 0;
    var a = ctx.auraByName[auraName];
    if (!a) return 0;
    var mag = Math.abs(a.baseDrain) + a.maxRank; // aura drain magnitude at max rank
    var framePol = frame.AuraPolarity || null;
    if (a.polarity === 'Any') return mag * 2;
    if (framePol && a.polarity === framePol) return mag * 2; // matching doubles
    if (!framePol || framePol === 'None') return mag;       // no slot polarity: neutral
    return Math.floor(mag / 2);                              // mismatched halves (floor)
  }

  function modDrainAt(mod, rank) { return mod.baseDrain + rank; }

  // Assign chosen mods to the frame's slots (greedy), then spend Forma.
  // umbraForma (default 0) is a SEPARATE budget: only it can turn a slot
  // Umbra to match an Umbra-polarity mod.
  function fitCapacity(ctx, frame, state, formaBudget, reactor, umbraForma) {
    // Necramech/Companion items carry _slotCount/_baseCapacity markers
    // (set in solve): their capacity is rank-cap based, not reactor based.
    var slotCount = frame._slotCount || 8;
    var capacityMax = (typeof frame._baseCapacity === 'number'
      ? frame._baseCapacity : (reactor ? 60 : 30)) +
      auraCapacityBonus(ctx, frame, state.aura);
    var slotPols = (frame.Polarities || []).slice(0, slotCount);
    while (slotPols.length < slotCount) slotPols.push(null);

    var chosen = Object.keys(state.mods).map(function (name) {
      return { name: name, mod: ctx.modByName[name], rank: state.mods[name] };
    });
    // Greedy assignment: largest drain first, prefer a polarity match.
    var order = chosen.slice().sort(function (a, b) {
      return modDrainAt(b.mod, b.rank) - modDrainAt(a.mod, a.rank);
    });
    var free = slotPols.map(function (_, i) { return i; });
    var assign = {}; // modName -> slotIndex
    order.forEach(function (c) {
      var idx = -1;
      for (var i = 0; i < free.length; i++) {
        if (slotPols[free[i]] && slotPols[free[i]] === c.mod.polarity) { idx = free[i]; break; }
      }
      if (idx < 0) idx = free[0];
      free.splice(free.indexOf(idx), 1);
      assign[c.name] = idx;
    });
    // Exilus slot: one extra slot with NO innate polarity, appended after
    // the 8 normal slots. The exilus mod is pinned to it; the Forma pass
    // below may polarise it like any other slot (same budget).
    if (state.exilusMod) {
      var exMod = ctx.modByName[state.exilusMod.name];
      if (exMod) {
        slotPols.push(null);
        assign[state.exilusMod.name] = slotPols.length - 1;
        chosen.push({
          name: state.exilusMod.name, mod: exMod, rank: state.exilusMod.rank
        });
      }
    }
    function costOf(c, pols) {
      var d = modDrainAt(c.mod, c.rank);
      return (pols[assign[c.name]] && pols[assign[c.name]] === c.mod.polarity)
        ? Math.ceil(d / 2) : d;
    }
    function totalCost(pols) {
      return chosen.reduce(function (s, c) { return s + costOf(c, pols); }, 0);
    }
    var pols = slotPols.slice();
    var cost = totalCost(pols);
    var formaPlan = [];
    var regularUsed = 0;
    var budget = (formaBudget === 'any' || formaBudget == null) ? Infinity : formaBudget;
    while (cost > capacityMax && regularUsed < budget) {
      // Forma the assigned slot with the largest saving (skip mods already
      // matched, and Umbra mods — regular Forma cannot create Umbra).
      var best = null;
      chosen.forEach(function (c) {
        var slot = assign[c.name];
        if (pols[slot] === c.mod.polarity) return;
        if (c.mod.polarity === 'Umbra' || !c.mod.polarity) return;
        var d = modDrainAt(c.mod, c.rank);
        var saving = d - Math.ceil(d / 2);
        if (saving > 0 && (!best || saving > best.saving)) {
          best = { slot: slot, polarity: c.mod.polarity, saving: saving };
        }
      });
      if (!best) break;
      pols[best.slot] = best.polarity;
      formaPlan.push({ slot: best.slot, polarity: best.polarity });
      regularUsed++;
      cost = totalCost(pols);
    }
    // Umbra Forma pass: only slots actually holding an Umbra-polarity
    // mod are candidates, and only the separate umbraForma budget pays.
    var umbraBudget = umbraForma || 0;
    var umbraUsedCount = 0;
    while (cost > capacityMax && umbraUsedCount < umbraBudget) {
      var ubest = null;
      chosen.forEach(function (c) {
        if (c.mod.polarity !== 'Umbra') return;
        var slot = assign[c.name];
        if (pols[slot] === 'Umbra') return;
        var d = modDrainAt(c.mod, c.rank);
        var saving = d - Math.ceil(d / 2);
        if (saving > 0 && (!ubest || saving > ubest.saving)) {
          ubest = { slot: slot, saving: saving };
        }
      });
      if (!ubest) break;
      pols[ubest.slot] = 'Umbra';
      formaPlan.push({ slot: ubest.slot, polarity: 'Umbra', umbra: true });
      umbraUsedCount++;
      cost = totalCost(pols);
    }
    return {
      capacityUsed: cost,
      capacityMax: capacityMax,
      formaUsed: regularUsed,
      umbraFormaUsed: umbraUsedCount,
      formaPlan: formaPlan,
      valid: cost <= capacityMax
    };
  }

  // ---- scoring ------------------------------------------------------------------
  function scoreState(targets, achieved, fit, state) {
    var shortfall = 0, closestDist = 0;
    Object.keys(targets).forEach(function (stat) {
      var t = targets[stat];
      if (!t || t.mode === 'dontcare' || typeof t.value !== 'number') return;
      var a = achieved[stat];
      if (t.mode === 'atleast') {
        if (a < t.value) shortfall += (t.value - a) / t.value;
      } else if (t.mode === 'closest') {
        closestDist += Math.abs(a - t.value) / Math.max(1, Math.abs(t.value));
      }
    });
    var pieces = modCount(state) + state.arcanes.length +
                 state.shards.length + (state.tome ? 1 : 0) + (state.aura ? 1 : 0) +
                 (state.helmet ? 1 : 0) + (state.subsume ? 1 : 0);
    var tertiary = modCount(state) * 0.01 +
                   fit.formaUsed * 0.01 + pieces * 0.002 + state.fusions.length * 0.002;
    var score = shortfall * 10000 + closestDist * 100 + tertiary;
    if (!fit.valid) score += 20000; // search must prefer valid arrangements
    return { score: score, shortfall: shortfall, closestDist: closestDist };
  }

  // ---- solver ---------------------------------------------------------------------
  function solve(input, data) {
    var ctx = buildContext(data);
    // Item kind: 'warframe' (default), 'necramech', 'companion'. The
    // non-frame kinds reuse this solver with their own base-stat entry,
    // mod pool, slot count and capacity rule; routes that do not exist
    // on those items (aura, arcanes, shards, tome, helmets, exilus) are
    // forced off below.
    var kind = (input.itemKind === 'necramech' || input.itemKind === 'companion')
      ? input.itemKind : 'warframe';
    var frame;
    if (kind === 'necramech') {
      var rawMech = ctx.necramechs[input.frameName];
      if (!rawMech) throw new Error('Unknown necramech: ' + input.frameName);
      frame = Object.assign({}, rawMech, {
        _slotCount: 12, _baseCapacity: (rawMech.MaxRank || 40) * 2
      });
      ctx.modPool = ctx.necramechPool;
      ctx.modByName = ctx.necramechByName;
    } else if (kind === 'companion') {
      // input.companionEntry (S3) overrides the store lookup — how
      // MODULAR companions (MOA/Hound) are solved: modular.js assembles
      // their base stats from parts, since the store publishes none.
      var rawComp = input.companionEntry || ctx.companions[input.frameName];
      if (!rawComp) throw new Error('Unknown companion: ' + input.frameName);
      if (typeof rawComp.Health !== 'number' ||
          typeof rawComp.Shield !== 'number' ||
          typeof rawComp.Armor !== 'number') {
        throw new Error('Companion has no base stats in the wiki store ' +
          '(modular companion — MOA/Hound stats come from parts): ' +
          input.frameName);
      }
      // Capacity assumption (documented): companions reach 60 capacity
      // at max rank like a reactor'd frame; no reactor item exists.
      frame = Object.assign({}, rawComp, { _slotCount: 10, _baseCapacity: 60 });
      var built = buildCompanionPool(ctx, rawComp, input.ownerStats || null);
      ctx.modPool = built.pool;
      ctx.modByName = built.byName;
    } else {
      frame = ctx.frames[input.frameName];
      if (!frame) throw new Error('Unknown frame: ' + input.frameName);
    }
    var slotLimit = frame._slotCount || 8;

    var routesIn = input.routes || {};
    var routes = {
      mods: routesIn.mods !== false,
      arcanes: routesIn.arcanes !== false,
      shards: routesIn.shards !== false,
      aura: routesIn.aura !== false,
      exilus: !!routesIn.exilus,               // extra exilus-only slot (see header)
      tome: routesIn.tome !== false,
      conditional: !!routesIn.conditional,
      legacyHelmets: !!routesIn.legacyHelmets, // DEFAULT OFF (Tacusin, 2026-10-18)
      helminth: !!routesIn.helminth           // DEFAULT OFF, same caution
    };
    if (kind !== 'warframe') {
      routes.arcanes = false; routes.shards = false; routes.aura = false;
      routes.exilus = false; routes.tome = false; routes.legacyHelmets = false;
      routes.helminth = false;
    }
    var targets = input.targets || {};
    var targetedStats = Object.keys(targets).filter(function (s) {
      return targets[s] && targets[s].mode !== 'dontcare' && typeof targets[s].value === 'number';
    });

    var baseAchieved = achievedFrom(ctx, frame,
      contributions(ctx, emptyState(input.shardWallet), routes, input.supportSetPieces));

    // Rank pruning: {maxRank} U {bracketing rank, bracket-1, half-gap rank}
    // per targeted stat, computed against the initial gap.
    function candidateRanks(mod) {
      var set = {};
      set[mod.maxRank] = true;
      mod.effects.forEach(function (e) {
        if (targetedStats.indexOf(e.stat) < 0) return;
        if (e.condition && !routes.conditional) return;
        var delta = targets[e.stat].value - baseAchieved[e.stat];
        if (!delta) return;
        var prev = 0;
        for (var r = 0; r <= mod.maxRank; r++) {
          var v = e.valuePerRank * (r + 1);
          if (Math.sign(v) === Math.sign(delta) && Math.abs(v) >= Math.abs(delta) && !set[r]) {
            set[r] = true; if (r > 0) set[r - 1] = true; break;
          }
          if (Math.sign(v) === Math.sign(delta) && Math.abs(v) >= Math.abs(delta) / 2 && Math.abs(prev) < Math.abs(delta) / 2) {
            set[r] = true;
          }
          prev = v;
        }
      });
      return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }

    // Candidate mods: touch at least one targeted stat.
    var candMods = [];
    if (routes.mods) {
      ctx.modPool.forEach(function (mod) {
        var touches = mod.effects.some(function (e) {
          return targetedStats.indexOf(e.stat) >= 0 && (!e.condition || routes.conditional);
        });
        if (touches) candMods.push({ mod: mod, ranks: candidateRanks(mod) });
      });
    }
    var candArcanes = routes.arcanes ? ctx.arcanes.filter(function (a) {
      return a.effects.some(function (e) { return targetedStats.indexOf(e.stat) >= 0; }) &&
             (!a.conditional || routes.conditional);
    }) : [];
    // Helminth subsume candidates (S3): dataset entries with modelled
    // effects touching a targeted stat, donor excluded by base-name
    // family (a frame — or its Prime — can never receive its own
    // ability). At most one subsume, replacing one UNLOCKED ability.
    function baseFrameName(n) { return String(n || '').replace(/ Prime$/, ''); }
    var frameAbilities = (kind === 'warframe' && frame && Array.isArray(frame.Abilities))
      ? frame.Abilities : [];
    var abilityLocks = Array.isArray(input.abilityLocks) ? input.abilityLocks : [];
    var candSubsumes = (routes.helminth && frameAbilities.length) ? ctx.helminth.filter(function (e) {
      if (baseFrameName(e.frame) === baseFrameName(input.frameName)) return false;
      return e.effects.some(function (ef) {
        return targetedStats.indexOf(ef.stat) >= 0 && (!ef.conditional || routes.conditional);
      });
    }) : [];
    var candTomes = (routes.tome && routes.conditional) ? ctx.tomes.filter(function (t) {
      return targetedStats.indexOf(t.stat) >= 0;
    }) : [];
    var candAuras = routes.aura ? ctx.auras.filter(function (a) {
      return a.effects.some(function (e) {
        return targetedStats.indexOf(e.stat) >= 0 && (!e.conditional || routes.conditional);
      });
    }) : [];
    var candShardPicks = routes.shards ? ctx.shardPicks.filter(function (p) {
      return targetedStats.indexOf(p.stat) >= 0;
    }) : [];
    var helmetList = routes.legacyHelmets
      ? (ctx.legacyHelmets[input.frameName] || []) : [];

    function evaluateWith(state, scoreFn) {
      var sums = contributions(ctx, state, routes, input.supportSetPieces);
      var achieved = achievedFrom(ctx, frame, sums);
      var fit = fitCapacity(ctx, frame, state, input.formaBudget,
                            input.reactor !== false, input.umbraForma || 0);
      var sc = scoreFn(targets, achieved, fit, state);
      return { state: state, achieved: achieved, fit: fit, score: sc.score,
               shortfall: sc.shortfall, closestDist: sc.closestDist || 0 };
    }

    // A mod may be placed (in either slot kind) if it is not already placed
    // and does not conflict with any placed mod, in either direction.
    function canPlace(state, mod) {
      var placed = Object.keys(state.mods);
      if (state.exilusMod) placed.push(state.exilusMod.name);
      if (placed.indexOf(mod.name) >= 0) return false;
      return !placed.some(function (u) {
        return (mod.incompatible || []).indexOf(u) >= 0 ||
               ((ctx.modByName[u].incompatible || []).indexOf(mod.name) >= 0);
      });
    }

    function expand(state) {
      var out = [];
      // Mods — normal slots. Exilus-flagged mods may also sit here.
      if (Object.keys(state.mods).length < slotLimit) {
        candMods.forEach(function (c) {
          if (!canPlace(state, c.mod)) return;
          c.ranks.forEach(function (r) {
            var ns = clone(state); ns.mods[c.mod.name] = r; out.push(ns);
          });
        });
      }
      // Exilus slot — exilus-flagged mods only, only when the route is on.
      if (routes.exilus && !state.exilusMod) {
        candMods.forEach(function (c) {
          if (!c.mod.exilus) return;
          if (!canPlace(state, c.mod)) return;
          c.ranks.forEach(function (r) {
            var ns = clone(state);
            ns.exilusMod = { name: c.mod.name, rank: r };
            out.push(ns);
          });
        });
      }
      // Arcanes (max 2)
      if (state.arcanes.length < 2) {
        candArcanes.forEach(function (a) {
          if (state.arcanes.indexOf(a.name) >= 0) return;
          var ns = clone(state); ns.arcanes.push(a.name); out.push(ns);
        });
      }
      // Tome (single pick)
      if (!state.tome) {
        candTomes.forEach(function (t) {
          var ns = clone(state); ns.tome = t.name; out.push(ns);
        });
      }
      // Aura (single pick)
      if (!state.aura) {
        candAuras.forEach(function (a) {
          var ns = clone(state); ns.aura = a.name; out.push(ns);
        });
      }
      // Legacy helmets — one candidate move per helmet in the frame's
      // list; still at most one helmet total, no slot / no capacity cost.
      if (!state.helmet && helmetList.length) {
        helmetList.forEach(function (h) {
          var ns = clone(state);
          ns.helmet = h.helmetName;
          ns._helmetFrame = input.frameName;
          out.push(ns);
        });
      }
      // Helminth subsume (S3): at most one; each candidate may replace
      // any one UNLOCKED ability slot (locked abilities never move).
      if (!state.subsume && candSubsumes.length) {
        candSubsumes.forEach(function (e) {
          frameAbilities.forEach(function (ab, idx) {
            if (abilityLocks[idx]) return;
            var ns = clone(state);
            ns.subsume = { ability: e.ability, fromFrame: e.frame, replacedAbility: ab };
            out.push(ns);
          });
        });
      }
      // Shards (max 5)
      if (state.shards.length < 5) {
        candShardPicks.forEach(function (p) {
          ['normal', 'tauforged'].forEach(function (tier) {
            var ns = clone(state);
            var fusion = spendShard(ns.wallet, input.shardWallet, p.colour, tier);
            if (fusion === false) return;
            if (fusion) ns.fusions.push(fusion);
            ns.shards.push({
              colour: p.colour, tier: tier, stat: p.stat, unit: p.unit,
              value: tier === 'tauforged' ? p.tauforged : p.normal
            });
            out.push(ns);
          });
        });
      }
      return out;
    }

    // Beam search with STRATIFIED selection: a plain top-N beam is myopic —
    // fast lanes (one big mod) reach zero shortfall in a few moves and flood
    // the beam, evicting slower lanes (e.g. the 0-mod arcane/shard/tome
    // path) before they finish stacking. So each round keeps the top
    // states per mod-count lane, then fills up with the best overall.
    var BEAM = 90, LANE = 12;
    function selectBeam(evals) {
      var sorted = evals.slice().sort(function (a, b) { return a.score - b.score; });
      var picked = {}, out = [];
      var lanes = {};
      sorted.forEach(function (ev) {
        var k = modCount(ev.state);
        (lanes[k] = lanes[k] || []).push(ev);
      });
      Object.keys(lanes).forEach(function (k) {
        lanes[k].slice(0, LANE).forEach(function (ev) {
          var sig = stateSignature(ev.state);
          if (!picked[sig]) { picked[sig] = true; out.push(ev); }
        });
      });
      for (var i = 0; i < sorted.length && out.length < BEAM; i++) {
        var sig2 = stateSignature(sorted[i].state);
        if (!picked[sig2]) { picked[sig2] = true; out.push(sorted[i]); }
      }
      return out.sort(function (a, b) { return a.score - b.score; });
    }

    // Beam search, parameterised by scoring function so the cheapest
    // pass can re-run the identical search with cost-dominant weights.
    // acceptFn (optional) restricts which valid states may be returned.
    // Termination: run until a round generates no new states, or the
    // round cap. Do NOT stop on a top-score plateau — slow lanes (many
    // small pieces, e.g. the 0-mod shard path) complete after the beam's
    // top score has already flattened on a fast lane's solution.
    function runSearch(scoreFn, acceptFn) {
      var start = emptyState(input.shardWallet);
      start._helmetFrame = input.frameName;
      var beam = [evaluateWith(start, scoreFn)];
      var bestValidEver = null;
      function consider(ev) {
        if (!ev.fit.valid) return;
        if (acceptFn && !acceptFn(ev)) return;
        if (!bestValidEver || ev.score < bestValidEver.score) bestValidEver = ev;
      }
      beam.forEach(consider);
      for (var round = 0; round < 22; round++) {
        var seen = {};
        var next = [];
        var newCount = 0;
        beam.forEach(function (ev) { seen[stateSignature(ev.state)] = true; next.push(ev); });
        beam.forEach(function (ev) {
          expand(ev.state).forEach(function (ns) {
            var sig = stateSignature(ns);
            if (seen[sig]) return;
            seen[sig] = true;
            newCount++;
            next.push(evaluateWith(ns, scoreFn));
          });
        });
        next.forEach(consider);
        beam = selectBeam(next);
        if (newCount === 0) break;
      }
      if (bestValidEver) return { ev: bestValidEver, fellBack: false };
      var finals = beam.slice().sort(function (a, b) { return a.score - b.score; });
      return { ev: finals[0] || evaluateWith(start, scoreFn), fellBack: true };
    }

    var mainRun = runSearch(scoreState, null);
    var chosenEv = mainRun.ev;

    // Cheapest variant: same search, cost weights dominant (fewest mods,
    // then fewest Forma, then fewest shards), restricted to states that
    // meet every At-least target the main result met (shortfall no
    // worse) and stay within 0.05 of its Closest distance.
    var cheapestEv = null;
    if (targetedStats.length) {
      var cheapScore = function (tg, achieved, fit, state) {
        var base = scoreState(tg, achieved, fit, state);
        // Cost order per the brief: fewest MODS dominate everything,
        // then fewest Forma, then fewest shards; other pieces only
        // break exact ties (a mod must never lose to shard costs).
        var cost = modCount(state) * 10000 + fit.formaUsed * 100 +
                   (fit.umbraFormaUsed || 0) * 100 + state.shards.length * 10 +
                   state.fusions.length * 5 + state.arcanes.length +
                   (state.tome ? 1 : 0) + (state.aura ? 1 : 0) +
                   (state.helmet ? 1 : 0) + (state.subsume ? 1 : 0);
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
          stateSignature(cheapRun.ev.state) !== stateSignature(chosenEv.state)) {
        cheapestEv = cheapRun.ev;
      }
    }

    // Set-bonus report for a finished state: pieces counted across the
    // focus item and cross-gear support pieces. Parsed bonuses that map
    // to a solver stat are already inside `achieved` (see contributions)
    // and are flagged applied here; everything else is reported so a
    // real mechanic is never silently absent from the result.
    function setBonusReport(state) {
      var counts = setPieceCounts(ctx, state, input.supportSetPieces);
      var out = [];
      Object.keys(counts).forEach(function (set) {
        var sb = ctx.setBonuses[set];
        var pieces = counts[set].focus + counts[set].support;
        if (!sb) {
          out.push({ set: set, pieces: pieces, focusPieces: counts[set].focus,
                     supportPieces: counts[set].support, parseStatus: 'unknown',
                     perPiece: null, totalValue: null, applied: false, sourceText: '' });
          return;
        }
        var applied = !!(sb.perPiece && sb.perPiece.some(function (pp) {
          return !!UT_TO_STAT[pp.upgradeType];
        }));
        out.push({
          set: set, pieces: pieces, focusPieces: counts[set].focus,
          supportPieces: counts[set].support, parseStatus: sb.parseStatus,
          perPiece: sb.perPiece,
          totalValue: (sb.perPiece && sb.perPiece.length === 1 &&
                       typeof sb.perPiece[0].value === 'number')
            ? sb.perPiece[0].value * pieces : null,
          applied: applied, sourceText: sb.sourceText
        });
      });
      return out.sort(function (a, b) { return a.set < b.set ? -1 : 1; });
    }

    function buildResult(evRes) {
      var st = evRes.state;
      var rNotes = [];
      if (kind === 'necramech') {
        rNotes.push('Necramech solve: 12 mod slots, capacity = rank cap x 2 ' +
          '(80 at rank 40), Necramech mod pool only — Necramechs have no ' +
          'aura, arcane, shard, tome, helmet or exilus routes.');
      } else if (kind === 'companion') {
        rNotes.push('Companion solve: 10 mod slots, capacity 60 at max rank ' +
          '(documented assumption: companions gain capacity to 60 at max ' +
          'rank; no reactor item exists for them).');
        if (input.ownerStats) {
          rNotes.push('Link mods scale off the supplied owner stats ' +
            '(health ' + (input.ownerStats.health || 0) + ', shield ' +
            (input.ownerStats.shield || 0) + ', armor ' +
            (input.ownerStats.armor || 0) + ').');
        } else if (ctx.linkMods.length) {
          rNotes.push('Link mods scale off the owner Warframe\'s stats; ' +
            'no ownerStats were supplied, so Link mods contribute 0 in ' +
            'this solve.');
        }
      }
      var achieved = {};
      ALL_STATS.forEach(function (k) { achieved[k] = round2(evRes.achieved[k]); });

      var unmet = [];
      targetedStats.forEach(function (stat) {
        var t = targets[stat];
        if (t.mode === 'atleast' && evRes.achieved[stat] < t.value - 1e-9) {
          unmet.push({ stat: stat, target: t.value, achieved: round2(evRes.achieved[stat]) });
        }
      });
      // Honest unlock hints for unmet targets.
      unmet.forEach(function (u) {
        var hints = [];
        if (!routes.arcanes) hints.push('arcanes');
        if (!routes.shards) hints.push('archon shards');
        if (!routes.tome) hints.push('tome mods');
        if (!routes.conditional) hints.push('conditional buffs');
        if (!routes.legacyHelmets && (ctx.legacyHelmets[input.frameName] || []).length) hints.push('the legacy Arcane Helmet');
        if (!routes.helminth && ctx.helminth.length) hints.push('a helminth subsume');
        if (hints.length) {
          rNotes.push('Target ' + u.stat + ' ' + u.target + ' was not reached (best ' + u.achieved + '). Disabled routes that could add more: ' + hints.join(', ') + '.');
        } else {
          rNotes.push('Target ' + u.stat + ' ' + u.target + ' was not reached; ' + u.achieved + ' is the best found with all enabled routes.');
        }
      });
      if (st.subsume) {
        rNotes.push('Helminth subsume: ' + st.subsume.ability + ' (from ' +
          st.subsume.fromFrame + ') replaces ' + st.subsume.replacedAbility +
          '. Modelled effects are the diminished values from the Helminth ' +
          'dataset; conditional effects count under the conditional route.');
      }
      st.fusions.forEach(function (f) {
        if (f.kind === 'ascent') rNotes.push('Ascent Fusion: 3x ' + f.colour + ' -> 1 Tauforged ' + f.colour + '.');
        if (f.kind === 'coalescent') rNotes.push('Coalescent Fusion: ' + f.parents.join(' + ') + ' -> ' + f.colour + '.');
      });
      if (st.arcanes.some(function (n) {
        var a = ctx.arcanes.filter(function (x) { return x.name === n; })[0];
        return a && a.conditional;
      })) {
        rNotes.push('Conditional arcane effects are counted at full stacks for the whole build (paper stats).');
      }
      var report = setBonusReport(st);
      report.forEach(function (r) {
        if (r.pieces >= 2 && r.parseStatus !== 'parsed' && r.parseStatus !== 'unknown') {
          rNotes.push('Set bonus for ' + r.set + ' not modelled (prose effect)' +
                      (r.sourceText ? ': "' + r.sourceText + '"' : '') + '.');
        }
      });

      // Ranking costs (Fusion page formula, see rankCostFor): every
      // chosen mod entry carries the Endo/Credits cost from rank 0 to
      // its solved rank; the result totals them.
      var totalRankCost = { endo: 0, credits: 0 };
      var unknownCost = [];
      function costedEntry(n, rank, slot) {
        var rc = rankCostFor(ctx.modByName[n], rank);
        if (rc) {
          totalRankCost.endo += rc.endo;
          totalRankCost.credits += rc.credits;
        } else {
          unknownCost.push(n);
        }
        return { name: n, rank: rank, slot: slot, rankCost: rc };
      }
      var costedMods = Object.keys(st.mods).sort().map(function (n) {
        return costedEntry(n, st.mods[n], 'normal');
      }).concat(st.exilusMod ? [costedEntry(st.exilusMod.name, st.exilusMod.rank, 'exilus')] : []);
      if (unknownCost.length) {
        rNotes.push('Ranking cost unknown for ' + unknownCost.join(', ') +
          ' (rarity outside the wiki Fusion page tables); totalRankCost ' +
          'excludes them.');
      }

      return {
        achieved: achieved,
        arrangement: {
          mods: costedMods,
          aura: st.aura || null,
          arcanes: st.arcanes.slice(),
          shards: st.shards.map(function (s) { return { colour: s.colour, tier: s.tier, stat: s.stat }; }),
          tome: st.tome || null,
          helmet: st.helmet || null,
          subsume: st.subsume ? {
            ability: st.subsume.ability, fromFrame: st.subsume.fromFrame,
            replacedAbility: st.subsume.replacedAbility
          } : null,
          formaUsed: evRes.fit.formaUsed,
          umbraFormaUsed: evRes.fit.umbraFormaUsed || 0,
          formaPlan: evRes.fit.formaPlan,
          capacityUsed: evRes.fit.capacityUsed,
          capacityMax: evRes.fit.capacityMax
        },
        setBonuses: report,
        unmetTargets: unmet,
        totalRankCost: totalRankCost,
        notes: rNotes
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

  var Solver = {
    solve: solve,
    _internal: {
      UT_TO_STAT: UT_TO_STAT,
      SHARD_STAT_MAP: SHARD_STAT_MAP,
      buildContext: buildContext,
      buildCompanionPool: buildCompanionPool,
      fitCapacity: fitCapacity,
      setPieceCounts: setPieceCounts,
      auraCapacityBonus: auraCapacityBonus,
      rankCostFor: rankCostFor,
      FUSION_ENDO: FUSION_ENDO,
      FUSION_CREDITS: FUSION_CREDITS
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Solver;
  }
  if (typeof window !== 'undefined') {
    window.Solver = Solver;
  }
})();
