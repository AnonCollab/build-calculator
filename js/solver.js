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
 *     arcaneEffects:  data/derived/arcane_effects_curated.json ({arcanes:[...]})
 *     tomeEffects:    data/derived/tome_effects.json    ({mods:[...]})
 *     auraEffects:    data/derived/aura_effects.json    ({mods:[...]})
 *     shardEffects:   data/derived/shard_effects.json  ({colours:{...}})
 *     warframes:      data/raw/warframes_data.json      ({Warframes:{...}})
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
 *  - Set bonuses are NOT computed: the derived data carries set bonus
 *    descriptions as prose only, no numeric values.
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
 *  - Umbra-polarity mods cannot be matched by regular Forma (needs an
 *    Umbra Forma, not modelled as a budget in v1).
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

  function round2(x) { return Math.round(x * 100) / 100; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---- data normalisation -------------------------------------------------
  function buildContext(data) {
    var ctx = { unmappedUpgradeTypes: {} };

    var wf = (data.warframes && data.warframes.Warframes) || {};
    ctx.frames = wf;

    // Mod pool: Warframe-type mods with clean/partial parses and at least
    // one effect that maps to a solver stat.
    ctx.modPool = [];
    var mods = (data.modsEffects && data.modsEffects.mods) || [];
    mods.forEach(function (m) {
      if (m.type !== 'Warframe') return;
      if (m.parseStatus !== 'clean' && m.parseStatus !== 'partial') return;
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
      if (!effs.length) return;
      ctx.modPool.push({
        name: m.name,
        polarity: m.polarity || null,
        baseDrain: m.baseDrain || 0,
        maxRank: m.maxRank || 0,
        incompatible: m.incompatible || [],
        set: m.set || null,
        exilus: !!m.exilus,
        effects: effs
      });
    });
    ctx.modByName = {};
    ctx.modPool.forEach(function (m) { ctx.modByName[m.name] = m; });

    // Arcanes (curated layer): effects already use solver stat keys.
    ctx.arcanes = ((data.arcaneEffects && data.arcaneEffects.arcanes) || []).map(function (a) {
      return {
        name: a.name,
        conditional: !!a.conditional,
        effects: (a.effects || []).filter(function (e) { return ALL_STATS.indexOf(e.stat) >= 0; })
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
        baseDrain: a.baseDrain || 0, maxRank: a.maxRank || 0, effects: effs
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
            s.tome || '', s.helmet || '', wal].join('|');
  }
  // Total mods placed (normal slots + exilus slot).
  function modCount(s) {
    return Object.keys(s.mods).length + (s.exilusMod ? 1 : 0);
  }

  // Sum a state's contributions: {stat: {percent, flat}}.
  function contributions(ctx, state, routes) {
    var sums = {};
    ALL_STATS.forEach(function (k) { sums[k] = { percent: 0, flat: 0 }; });
    function add(stat, unit, v) {
      if (!sums[stat]) return;
      if (unit === 'flat') sums[stat].flat += v; else sums[stat].percent += v;
    }
    function addModEffects(mod, rank) {
      if (!mod) return;
      mod.effects.forEach(function (e) {
        if (e.condition && !routes.conditional) return;
        add(e.stat, e.unit, e.valuePerRank * (rank + 1));
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
  function fitCapacity(ctx, frame, state, formaBudget, reactor) {
    var capacityMax = (reactor ? 60 : 30) + auraCapacityBonus(ctx, frame, state.aura);
    var slotPols = (frame.Polarities || []).slice(0, 8);
    while (slotPols.length < 8) slotPols.push(null);

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
    var budget = (formaBudget === 'any' || formaBudget == null) ? Infinity : formaBudget;
    while (cost > capacityMax && formaPlan.length < budget) {
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
      cost = totalCost(pols);
    }
    return {
      capacityUsed: cost,
      capacityMax: capacityMax,
      formaUsed: formaPlan.length,
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
                 (state.helmet ? 1 : 0);
    var tertiary = modCount(state) * 0.01 +
                   fit.formaUsed * 0.01 + pieces * 0.002 + state.fusions.length * 0.002;
    var score = shortfall * 10000 + closestDist * 100 + tertiary;
    if (!fit.valid) score += 20000; // search must prefer valid arrangements
    return { score: score, shortfall: shortfall, closestDist: closestDist };
  }

  // ---- solver ---------------------------------------------------------------------
  function solve(input, data) {
    var ctx = buildContext(data);
    var frame = ctx.frames[input.frameName];
    if (!frame) throw new Error('Unknown frame: ' + input.frameName);

    var routesIn = input.routes || {};
    var routes = {
      mods: routesIn.mods !== false,
      arcanes: routesIn.arcanes !== false,
      shards: routesIn.shards !== false,
      aura: routesIn.aura !== false,
      exilus: !!routesIn.exilus,               // extra exilus-only slot (see header)
      tome: routesIn.tome !== false,
      conditional: !!routesIn.conditional,
      legacyHelmets: !!routesIn.legacyHelmets // DEFAULT OFF (Tacusin, 2026-10-18)
    };
    var targets = input.targets || {};
    var targetedStats = Object.keys(targets).filter(function (s) {
      return targets[s] && targets[s].mode !== 'dontcare' && typeof targets[s].value === 'number';
    });
    var notes = [];

    var baseAchieved = achievedFrom(ctx, frame, contributions(ctx, emptyState(input.shardWallet), routes));

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

    function evaluate(state) {
      var sums = contributions(ctx, state, routes);
      var achieved = achievedFrom(ctx, frame, sums);
      var fit = fitCapacity(ctx, frame, state, input.formaBudget, input.reactor !== false);
      var sc = scoreState(targets, achieved, fit, state);
      return { state: state, achieved: achieved, fit: fit, score: sc.score, shortfall: sc.shortfall };
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
      if (Object.keys(state.mods).length < 8) {
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

    var start = emptyState(input.shardWallet);
    start._helmetFrame = input.frameName;
    var beam = [evaluate(start)];
    var bestValidEver = null;
    // Termination: run until a round generates no new states, or the round
    // cap. Do NOT stop on a top-score plateau — slow lanes (many small
    // pieces, e.g. the 0-mod shard path) complete after the beam's top
    // score has already flattened on a fast lane's solution.
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
          next.push(evaluate(ns));
        });
      });
      next.forEach(function (ev) {
        if (ev.fit.valid && (!bestValidEver || ev.score < bestValidEver.score)) bestValidEver = ev;
      });
      beam = selectBeam(next);
      if (newCount === 0) break;
    }

    // Final pick: best-scoring VALID state seen (final beam or any earlier
    // round); fall back to best overall, flagged in notes.
    var finals = beam.slice().sort(function (a, b) { return a.score - b.score; });
    if (bestValidEver) finals.push(bestValidEver);
    var chosenEv = null;
    for (var i = 0; i < finals.length; i++) {
      if (finals[i].fit.valid) { chosenEv = finals[i]; break; }
    }
    if (!chosenEv) {
      chosenEv = finals[0] || evaluate(start);
      notes.push('No arrangement within the Forma budget fits the mod capacity; showing the best-scoring arrangement, which exceeds capacity.');
    }
    var st = chosenEv.state;

    var achieved = {};
    ALL_STATS.forEach(function (k) { achieved[k] = round2(chosenEv.achieved[k]); });

    var unmet = [];
    targetedStats.forEach(function (stat) {
      var t = targets[stat];
      if (t.mode === 'atleast' && chosenEv.achieved[stat] < t.value - 1e-9) {
        unmet.push({ stat: stat, target: t.value, achieved: round2(chosenEv.achieved[stat]) });
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
      if (hints.length) {
        notes.push('Target ' + u.stat + ' ' + u.target + ' was not reached (best ' + u.achieved + '). Disabled routes that could add more: ' + hints.join(', ') + '.');
      } else {
        notes.push('Target ' + u.stat + ' ' + u.target + ' was not reached; ' + u.achieved + ' is the best found with all enabled routes.');
      }
    });
    st.fusions.forEach(function (f) {
      if (f.kind === 'ascent') notes.push('Ascent Fusion: 3x ' + f.colour + ' -> 1 Tauforged ' + f.colour + '.');
      if (f.kind === 'coalescent') notes.push('Coalescent Fusion: ' + f.parents.join(' + ') + ' -> ' + f.colour + '.');
    });
    if (st.arcanes.some(function (n) {
      var a = ctx.arcanes.filter(function (x) { return x.name === n; })[0];
      return a && a.conditional;
    })) {
      notes.push('Conditional arcane effects are counted at full stacks for the whole build (paper stats).');
    }

    return {
      achieved: achieved,
      arrangement: {
        mods: Object.keys(st.mods).sort().map(function (n) {
          return { name: n, rank: st.mods[n], slot: 'normal' };
        }).concat(st.exilusMod ? [{
          name: st.exilusMod.name, rank: st.exilusMod.rank, slot: 'exilus'
        }] : []),
        aura: st.aura || null,
        arcanes: st.arcanes.slice(),
        shards: st.shards.map(function (s) { return { colour: s.colour, tier: s.tier, stat: s.stat }; }),
        tome: st.tome || null,
        helmet: st.helmet || null,
        formaUsed: chosenEv.fit.formaUsed,
        formaPlan: chosenEv.fit.formaPlan,
        capacityUsed: chosenEv.fit.capacityUsed,
        capacityMax: chosenEv.fit.capacityMax
      },
      unmetTargets: unmet,
      notes: notes
    };
  }

  var Solver = {
    solve: solve,
    _internal: {
      UT_TO_STAT: UT_TO_STAT,
      SHARD_STAT_MAP: SHARD_STAT_MAP,
      buildContext: buildContext,
      fitCapacity: fitCapacity,
      auraCapacityBonus: auraCapacityBonus
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Solver;
  }
  if (typeof window !== 'undefined') {
    window.Solver = Solver;
  }
})();
