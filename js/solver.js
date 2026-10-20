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
 *  - Cheapest variant: v1.0 re-ran the search with cost-dominant
 *    weights; v1.1 REDEFINES result.cheapest as the no-fill solve
 *    (targets only) when the Maximize fill phase changed the build,
 *    and null when it did not (see the v1.1 notes below).
 *
 * v1.1 (engine stage E1):
 *  - Maximize mode: target entries may use mode 'maximize' with an
 *    optional priority. The beam solves the hard targets (at-least
 *    floors, then Closest distance) exactly as before; a fill phase
 *    then spends ONLY leftover resources to raise the Maximize stats
 *    lexicographically by priority, never worsening any target
 *    outcome. Pieces carry origin 'target' | 'fill'; result.fillPieces
 *    lists what the fill added.
 *  - Ordered slot list: arrangement.slots derives from the fit's
 *    slotInfo (single source of truth for placement/polarity/drain).
 *  - Locks: input.lockedMods / input.lockedArcanes pin pieces the
 *    search must include at the player's rank (stat-less mods via
 *    input.extraModRecords); the only permitted change is the
 *    reported capacity rank trim.
 *  - Deficit lanes: the beam also keeps up to 2 states per at-least
 *    stat (6 per round max) that are below the floor but hold the
 *    highest gross positive contribution toward it.
 *  - evaluateFrame(data, frameName, orderedPieces): forward
 *    evaluator for the board editor, sharing this file's math.
 *
 * v1.2 (engine stage F1):
 *  - Excludes: input.excludedMods / input.excludedArcanes ban pieces
 *    from every candidate pool (search AND fill); a piece that is
 *    both locked and excluded is a hard Error.
 *  - Helminth forced choice: input.helminthChoice {donor,
 *    replacesIndex} pins the subsume the player picked (seeded into
 *    the start states, so the auto-pick can never override it).
 *    Modelled donors apply as usual; non-modelled donors ride as
 *    arrangement.subsumeInstruction — a build instruction with the
 *    diminished text, never a stat effect.
 *  - Cross-gear planning: with input.crossGear present, the finished
 *    build gains result.crossGearPlan — specific mods on specific
 *    support gear completing reachable set bonuses — and planned
 *    pieces count in setBonuses totals immediately.
 *    input.supportSetPieces remains accepted (legacy counts) but is
 *    no longer the primary path.
 *  - Breakdowns: results and evaluateFrame return `breakdown` —
 *    per-stat contributor chains in application order whose final
 *    cumulative equals the reported achieved value (round2). Each
 *    entry also carries `delta`, its own increase over the previous
 *    entry (Base's delta is its own value), so deltas sum to the
 *    final cumulative.
 *
 * v1.4 (engine stage):
 *  - Restricted pieces: derived records may carry `restrictedTo`
 *    (the pipeline turns item-named Types — augments, weapon-
 *    specific mods — into category records restricted to one item).
 *    A restricted candidate is eligible ONLY when solving for that
 *    item: EXACT item-name match. Weapon FAMILY variants (a Sobek
 *    mod on a Kuva Sobek) are NOT admitted — family membership is
 *    not in the source data as an eligibility rule, so it is left
 *    as a noted limitation rather than guessed. Companion pools
 *    filter by the companion's Name the same way; link mods are
 *    unrestricted and unaffected.
 *  - Ability augments (Warframe-type restricted records): locks are
 *    governed by the Augments route (input.routes.augments, default
 *    OFF — the Stage 0 measurement found ZERO stat-bearing frame
 *    augments, so the toggle gates lock honouring only; the engine
 *    never auto-picks mechanic augments). With the route ON, a
 *    locked augment is honoured iff augmentEligible() says the
 *    frame currently HAS the augmented ability: natively, or via
 *    the current Helminth choice (which also REMOVES eligibility
 *    for the ability it replaces). Unlinked augments (no extracted
 *    ability link) fall back to native-frame restriction only.
 *    Ineligible or route-off augment locks are dropped with a
 *    result note (warn-never-block), never a hard error.
 *  - Hybrid intent: input.intent 'hybrid' + input.hybridAllowance
 *    (1 | 2, default 1; input.burstAllowance accepted as an alias)
 *    — upkeep discipline with a burst ALLOWANCE: burst candidates
 *    stay in the pools, but a build may hold at most N SOLVER-
 *    CHOSEN burst pieces (search and fill both enforce the cap).
 *    Per Q1's resolution, LOCKED burst pieces (and a forced
 *    Helminth subsume) do NOT consume the allowance — locks already
 *    override pruning outright. result.hybridBurst names the
 *    solver-chosen burst pieces; the sustained floor is unchanged
 *    (ALL burst pieces stripped, locked included). Window / upkeep
 *    / unset behaviour is byte-identical to v1.3.
 *
 * v1.5 (channel drain, frames only):
 *  - Data: data.channels = {abilities: {name: {frame,
 *    baseDrainPerSec, resource, note}}} (pipeline/
 *    extract_channels.py: the channeled set from Module:Ability/
 *    data's IsChanneled flags; base drains parsed from each
 *    ability's own wiki page — the store carries no drain field).
 *    A frame's tracked channel is the HIGHEST-drain channeled
 *    ability among its native abilities (the conservative choice;
 *    primes inherit via their own ability lists). Native abilities
 *    only: a channeled ability gained via Helminth does not confer
 *    the stat.
 *  - Formula (wiki pages "Ability Efficiency" + "Channeled
 *    Abilities", verified Stage C0):
 *      drain/sec = baseDrain x clamp((200 - Eff%) / Dur%, 0.25, 1.75)
 *    Eff% is the build's UNCAPPED efficiency (the 175% cast cap
 *    does not apply to drain); Dur% is its duration. achievedFrom
 *    emits achieved.channelDrain (+ result.channel names the
 *    tracked ability) whenever the frame has a tracked channel.
 *  - Q2 resolution: drain is lower-better, so an 'atleast' target
 *    on channelDrain reads "at or below" — the per-target
 *    lowerBetter convention weaponSolver.js already uses (default
 *    true for this stat), applied in scoreState, the fill guard
 *    and unmet reporting. Achieved values are always the real
 *    drain/sec, never an inverted number. Maximize is not offered
 *    for channelDrain (raising a drain is meaningless); a maximize
 *    entry is dropped with a result note.
 *  - Preference: input.channelPreference 'efficiency' | 'duration'
 *    (default 'efficiency') adds a small ordering bias inside
 *    scoreState ONLY while a channelDrain target is active — a
 *    tie-break among builds, never a change to any achieved value.
 *    No channelDrain target -> no bias -> solves byte-identical to
 *    v1.4.1.
 *
 * v1.5 (Focus schools, frames only):
 *  - Data: data.focus = {schools: [{name, ...}], nodes: [...]}
 *    (data/derived/focus.json — Module:Focus/data extraction,
 *    pipeline/extract_focus.py). Only nodes whose status is
 *    'modelled' (a stat derivation the source text supports) can be
 *    pieces; prose / operator-only nodes ship as documentation and
 *    are never fielded.
 *  - Route: input.routes.focus = {school: '<name>'} picks ONE
 *    school per build (Helminth-choice shape). The school's modelled
 *    nodes apply as FIXED route contributions (the school is the
 *    player's pick, not a searched choice): unconditional nodes
 *    always apply; conditional nodes count only under the
 *    conditional route, like every conditional piece. No pick (or a
 *    non-warframe kind) -> no focus contributions -> solves
 *    byte-identical to before. An unknown school name is a hard
 *    Error (same precedent as an unknown Helminth donor).
 *  - Intent: modelled conditional nodes carry v1.3 class rows
 *    (kind 'focus'). Under 'upkeep' a burst-class focus node is
 *    pruned from the contributions with a result note (Stage F2:
 *    school actives obey intent exactly like mods/arcanes). Under
 *    'hybrid' burst focus nodes are KEPT and do NOT consume the
 *    burst allowance — the allowance counts SOLVER-CHOSEN pieces
 *    (Q1), and the school is the player's explicit pick, the same
 *    class as a forced Helminth choice. The sustained floor strips
 *    burst focus nodes like every burst piece. Contributions land
 *    in the per-stat breakdown as 'Focus · <School> — <Node>'
 *    steps, and the kept set is reported as arrangement.focus
 *    {school, nodes}. evaluateFrame takes pieces.focus in the same
 *    {school, nodes} shape (nodes omitted = the school's full
 *    modelled set) for board parity.
 *
 * v1.5.1 Stage B (spare the shards, warframe kind only):
 *  - input.spareShards (bool, default false): Tacusin's preference —
 *    when a stat target can be covered either by Archon Shards or by
 *    mods paid for with Forma (within the build's Forma budget),
 *    spend the Forma first and keep the shards free. (He previously
 *    forced the trade by locking Primed Continuity; this automates
 *    it.) Mechanism: a per-shard score weight inside scoreState
 *    (0.05/shard via opts.spareShards — see the comment there for the
 *    sizing), which reprices shard lanes above mod+Forma lanes
 *    everywhere scoreState ranks states (beam selection, best-valid
 *    tracking, the lock trim re-evaluation).
 *    Nothing is banned: when mods + Forma within budget cannot meet
 *    a target, shards are spent as before (pinned by test: the
 *    golden scenario at Forma budget 0 falls back to shards), and
 *    the weight can never outvote a target term. Locks are
 *    untouched — a locked shard is impossible (shards are never
 *    lockable) and locked mods still ride the start states.
 *  - Invariance: flag unset/false -> scoreOpts carries no
 *    spareShards field -> every score is byte-identical to Stage A.
 *
 * v1.5.3 (aura slot):
 *  - input.omniAura (bool, default false): the build uses an Omni
 *    Forma on the aura slot — the slot becomes a universal match
 *    (capacity bonus x2 for any aura). A toggle, not a pool
 *    (Tacusin's design: one forma on one slot). The Omni Forma
 *    counts as 1 in the build's total formaUsed (it IS a Forma —
 *    Tacusin's correction), but as a user declaration it is NOT
 *    charged against the Forma budget: discretionary purchases
 *    still respect the budget, so a total can read budget-spend + 1.
 *    fitCapacity / evaluateFrame price it identically;
 *    evaluateFrame takes pieces.omniAura in the same role.
 *  - Without the toggle, the fit may buy the aura match with 1
 *    regular Forma (see fitCapacity's header note for the purchase
 *    discipline), and the aura mismatch bonus is the wiki's 80%
 *    rounded down (see auraCapacityBonus).
 *
 * v1.6.1 (#22 — Arcane Sculptor):
 *  - Sculptor's effect is a LOCK, not a sum: the curated layer
 *    encodes it as {kind: 'lock', value: 175, lockByRank:
 *    [125,135,145,155,165,175]} (wiki "Arcane Sculptor": Ability
 *    Efficiency is "locked at (not increased by)" the value;
 *    the table is sourced data, never derived). While the
 *    effect applies (Conditional route, like every conditional
 *    arcane), achievedFrom sets abilityEfficiency to the lock
 *    value BEFORE the channel-drain read and the 175 cap — so
 *    the uncapped efficiency the drain formula reads IS the
 *    lock value, and a lock below a build's summed efficiency
 *    (below-max rank, or a >175% sum at max rank) reduces it.
 *    The solver fields arcanes at max rank only (global design);
 *    the mechanism is rank-agnostic.
 *  - Eligibility is ability-gated (the augment rule): the entry
 *    carries validAbilities (the wiki's Valid Objects list).
 *    solve() fields a gated arcane only when the frame's
 *    EFFECTIVE abilities (native, minus the subsume's replaced
 *    ability, plus the subsume's donor ability) include a
 *    listed one — enforced on arcane-add and subsume-add moves
 *    in expand(), and on locked arcanes (an ineligible lock is
 *    dropped with a note, the augment-lock precedent).
 *    evaluateFrame stays intent-free and does not gate.
 *
 * v1.6.0 (#14 — polarity-mismatch drain penalty):
 *  - A mod in a slot of a DIFFERENT polarity costs ceil(drain x
 *    1.25) (wiki "Polarity"), priced everywhere through the shared
 *    drainInSlot helper: fitCapacity's pool counting (seat
 *    accounting — leftover mods arrange to minimise the penalty,
 *    so only the smallest polarized leftovers that cannot avoid a
 *    polarized seat pay it), evaluateFrame's given mode, and the
 *    slot list's per-slot drains, which still sum exactly to the
 *    counted capacityUsed. A 'Universal' slot is NOT a mismatch
 *    (and does not halve Umbra — #17); a no-polarity slot is full
 *    drain, no penalty. The aura bonus rule above is a separate
 *    rule and is untouched.
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
      restrictedTo: m.restrictedTo || null,       // v1.4
      augmentsAbility: m.augmentsAbility || null, // v1.4
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
    ctx._companionTypes = types; // lock validation (v1.1) reads the type set
    var built = poolFromTypes(ctx, ctx.derivedMods, types);
    // v1.4: companion-restricted records (restrictedTo = a species /
    // breed Name, e.g. 'Sahasa Kubrow') belong to that companion
    // only — exact Name match, the same conservative rule as
    // weapons. Link mods carry no restriction and pass through.
    if (entry.Name) {
      built.pool = built.pool.filter(function (rec) {
        return !rec.restrictedTo || rec.restrictedTo === entry.Name;
      });
      built.byName = {};
      built.pool.forEach(function (rec) { built.byName[rec.name] = rec; });
    }
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

  // v1.3: is this piece burst-class per the Stage 1 classification
  // (data.conditionalClasses, keyed by piece name)? Unclassified and
  // non-conditional pieces are never burst.
  function isBurstPiece(ctx, name) {
    var r = name ? ctx.condClasses[name] : null;
    return !!(r && r.class === 'burst');
  }

  // ---- v1.4: restricted pieces + ability augments -------------------
  function baseFrameName(n) { return String(n || '').replace(/ Prime$/, ''); }

  // Is this record an ability augment? In the derived data, augments
  // are Warframe-type records carrying a restriction (restrictedTo =
  // the owning frame) and, when the link extraction resolved one, an
  // augmentsAbility. (Hysterical Fixation — flagged IsAbilityAugment
  // in the source but typed plain 'Warframe' with no restriction —
  // is deliberately NOT one here: no restriction is derivable, and
  // the audit flags it instead of guessing.)
  function isAugmentRecord(rec) {
    return !!rec && rec.type === 'Warframe' &&
      !!(rec.augmentsAbility || rec.restrictedTo);
  }

  // Tacusin's rule: eligibility follows the ABILITY, not the frame.
  // A linked augment (augmentsAbility set) is eligible iff that
  // ability is in the frame's EFFECTIVE ability set: the native
  // list (frameAbilities), minus the ability the Helminth choice
  // replaces (helminthChoice.replacesIndex), plus the choice's donor
  // ability. This subsumes the native case and the subsume case
  // (Quiver on Cyte-09 => Empowered Quiver eligible there; Ivara
  // with Quiver replaced => not eligible on Ivara). An UNLINKED
  // augment falls back to native-frame restriction only — a subsume
  // never makes it eligible — with Prime variants normalised the
  // same way the Helminth own-family check normalises them.
  // Exported (Solver.augmentEligible) so the site shares one rule.
  function augmentEligible(rec, frameName, helminthChoice, frameAbilities) {
    if (!rec) return false;
    var abilities = Array.isArray(frameAbilities) ? frameAbilities : [];
    if (rec.augmentsAbility) {
      if (!helminthChoice) return abilities.indexOf(rec.augmentsAbility) >= 0;
      var eff = abilities.filter(function (_, i) {
        return i !== helminthChoice.replacesIndex;
      });
      if (helminthChoice.donor) eff.push(helminthChoice.donor);
      return eff.indexOf(rec.augmentsAbility) >= 0;
    }
    if (!rec.restrictedTo) return false;
    return baseFrameName(rec.restrictedTo) === baseFrameName(frameName);
  }

  // ---- v1.6.1: ability-gated arcanes (Arcane Sculptor) -------------
  // The entry carries validAbilities (the wiki's Valid Objects
  // whitelist). Eligibility follows the ABILITY — the augment rule
  // above: the frame's EFFECTIVE abilities (native, minus the
  // subsume's replaced ability, plus the subsume's donor ability)
  // must include a listed one. Ungated entries are always eligible.
  function effectiveAbilities(frameAbilities, subsume) {
    var eff = (Array.isArray(frameAbilities) ? frameAbilities : []).slice();
    if (subsume) {
      eff = eff.filter(function (a) { return a !== subsume.replacedAbility; });
      if (subsume.ability) eff.push(subsume.ability);
    }
    return eff;
  }
  function arcaneEligibleOn(entry, abilities) {
    if (!entry || !entry.validAbilities) return true;
    return entry.validAbilities.some(function (a) {
      return abilities.indexOf(a) >= 0;
    });
  }
  // Eligibility of a gated arcane against a forced Helminth choice
  // ({donor, replacesIndex} shape, as augmentEligible takes it).
  function arcaneEligibleChoice(entry, helminthChoice, frameAbilities) {
    if (!entry || !entry.validAbilities) return true;
    if (!helminthChoice) {
      return arcaneEligibleOn(entry, frameAbilities);
    }
    var eff = (Array.isArray(frameAbilities) ? frameAbilities : [])
      .filter(function (_, i) { return i !== helminthChoice.replacesIndex; });
    if (helminthChoice.donor) eff.push(helminthChoice.donor);
    return arcaneEligibleOn(entry, eff);
  }

  // v1.4 hybrid allowance: input.hybridAllowance (1 | 2, default 1);
  // input.burstAllowance is accepted as an alias (the site state
  // names it that). Anything that is not exactly 2 means 1.
  function burstAllowanceOf(input) {
    var a = (typeof input.hybridAllowance === 'number') ? input.hybridAllowance
      : (typeof input.burstAllowance === 'number') ? input.burstAllowance : 1;
    return a === 2 ? 2 : 1;
  }

  function buildContext(data) {
    var ctx = { unmappedUpgradeTypes: {} };

    // v1.3 conditional-piece classes (Stage 1): {name: {kind, class,
    // windowSeconds, maxStacks, trigger, evidence}}. Optional bundle
    // key — absent means no intent pruning anywhere.
    ctx.condClasses = (data && data.conditionalClasses) || {};

    // v1.5 channel data: {abilities: {name: {frame, baseDrainPerSec,
    // resource, note}}}. Optional bundle key — absent means no frame
    // has a tracked channel and channelDrain never appears.
    ctx.channelByAbility = (data && data.channels &&
      data.channels.abilities) || {};

    // v1.5 Focus schools: modelled nodes by school (the only nodes
    // that can be pieces — effects filtered to the solver's stats,
    // same discipline as arcanes), plus per-school status counts for
    // the result notes. ctx.focusActive is the per-solve kept set,
    // set by solve()/evaluateFrame (never shared state).
    ctx.focusBySchool = {};
    ctx.focusCounts = {};
    ((data && data.focus && data.focus.nodes) || []).forEach(function (n) {
      if (!n || !n.name || !n.school) return;
      var c = ctx.focusCounts[n.school] ||
        (ctx.focusCounts[n.school] = { modelled: 0, prose: 0, operatorOnly: 0 });
      if (n.status === 'modelled') {
        c.modelled++;
        var node = {
          name: n.name, school: n.school,
          conditional: !!n.conditional,
          effects: (n.effects || []).filter(function (e) {
            return ALL_STATS.indexOf(e.stat) >= 0 &&
              typeof e.value === 'number';
          })
        };
        if (node.effects.length) {
          (ctx.focusBySchool[n.school] =
            ctx.focusBySchool[n.school] || []).push(node);
        }
      } else if (n.status === 'operator-only') {
        c.operatorOnly++;
      } else {
        c.prose++;
      }
    });
    ctx.focusActive = null;

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
    // ALL subsumes (v1.2 forced choice): the player may force any
    // donor, modelled or not — non-modelled entries carry their
    // diminished text and ride as a build instruction only.
    ctx.helminthAll = ((data.helminth && data.helminth.subsumes) || [])
      .filter(function (e) { return e && e.ability; })
      .map(function (e) {
        return {
          ability: e.ability, frame: e.frame || '',
          diminishedText: e.diminishedText || '',
          effects: Array.isArray(e.effects) ? e.effects : null,
          modelled: Array.isArray(e.effects) && e.effects.length > 0
        };
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
    // name -> {type, set} for every derived mod (v1.2 cross-gear
    // planning reads member types for gear labels / focus-pool tests,
    // including mods the stat model dropped from the pools).
    ctx.derivedByName = {};
    mods.forEach(function (m) {
      ctx.derivedByName[m.name] = { type: m.type || null, set: m.set || null };
    });

    // Every arcane name in the bundle (v1.1 locks may occupy a slot
    // with an arcane the stat model cannot use).
    ctx.arcaneNames = ((data.arcaneEffects && data.arcaneEffects.arcanes) || [])
      .map(function (a) { return a.name; });
    // Arcanes: effects already use solver stat keys. Non-numeric
    // values (unbounded per-stack parses from the full pool) are
    // dropped — the solver cannot count what the text cannot bound.
    ctx.arcanes = ((data.arcaneEffects && data.arcaneEffects.arcanes) || []).map(function (a) {
      return {
        name: a.name,
        conditional: !!a.conditional,
        maxRank: typeof a.maxRank === 'number' ? a.maxRank : null,
        // v1.6.1: ability whitelist for gated arcanes (the wiki's
        // Valid Objects list for Arcane Sculptor); null = ungated.
        validAbilities: Array.isArray(a.validAbilities) ? a.validAbilities : null,
        effects: (a.effects || []).filter(function (e) {
          return ALL_STATS.indexOf(e.stat) >= 0 && typeof e.value === 'number';
        }).map(function (e) {
          // v1.6.1: a 'lock' effect SETS its stat to the value
          // (per-rank table rides through as sourced data); the
          // original effect shape is otherwise preserved verbatim.
          var out = {};
          Object.keys(e).forEach(function (k) { out[k] = e[k]; });
          out.kind = e.kind || null;
          out.lockByRank = Array.isArray(e.lockByRank) ? e.lockByRank : null;
          return out;
        })
      };
    }).filter(function (a) { return a.effects.length; });
    ctx.arcaneByName = {};
    ctx.arcanes.forEach(function (a) { ctx.arcaneByName[a.name] = a; });

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
        numUpgradesInSet: s.numUpgradesInSet || null,
        members: Array.isArray(s.members) ? s.members.slice() : []
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

  // Sum a state's contributions: {stat: {percent, flat}}. The walker
  // optionally reports every individual contribution to `collect`
  // (stat, unit, v) — the deficit-lane metric (v1.1) uses it to total
  // only the POSITIVE contributions toward one stat.
  function contributions(ctx, state, routes, supportSetPieces) {
    return walkContributions(ctx, state, routes, supportSetPieces, null, false);
  }
  // noSetBonuses (v1.2 breakdowns): skip the per-piece set block and
  // the set-enhance scaling, so a prefix state can be scored with set
  // bonuses attributed to a single final "Set bonuses" step instead
  // of leaking into whichever mod prefix completed the count.
  function walkContributions(ctx, state, routes, supportSetPieces, collect, noSetBonuses) {
    var sums = {};
    ALL_STATS.forEach(function (k) { sums[k] = { percent: 0, flat: 0 }; });
    var counts = setPieceCounts(ctx, state, supportSetPieces);
    function add(stat, unit, v) {
      if (!sums[stat]) return;
      if (unit === 'flat') sums[stat].flat += v; else sums[stat].percent += v;
      if (collect) collect(stat, unit, v);
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
      if (!noSetBonuses && sb && typeof sb.enhanceModsPercent === 'number') {
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
      a.effects.forEach(function (e) {
        // v1.6.1: a lock effect SETS its stat (achievedFrom reads
        // sums[stat].lock) — it never adds to the percent sum.
        if (e.kind === 'lock') { sums[e.stat].lock = e.value; return; }
        add(e.stat, e.unit, e.value);
      });
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
    if (!noSetBonuses) Object.keys(counts).forEach(function (set) {
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
    // Focus school nodes (v1.5): fixed route contributions held on
    // ctx (per-solve kept set — intent filtering happened where the
    // set was installed). Conditional nodes count only under the
    // conditional route, like every conditional piece.
    if (ctx.focusActive) {
      ctx.focusActive.forEach(function (node) {
        if (node.conditional && !routes.conditional) return;
        node.effects.forEach(function (e) { add(e.stat, e.unit, e.value); });
      });
    }
    return sums;
  }

  // Gross POSITIVE contribution toward one stat (percent/flat parts,
  // negatives ignored) — the deficit-lane metric: a state deep below a
  // floor but holding a large positive contribution (e.g. a corrupted
  // mod's upside) is worth keeping in the beam.
  function grossPositive(ctx, state, routes, supportSetPieces, stat) {
    var acc = { percent: 0, flat: 0 };
    walkContributions(ctx, state, routes, supportSetPieces, function (s, unit, v) {
      if (s !== stat || !(v > 0)) return;
      if (unit === 'flat') acc.flat += v; else acc.percent += v;
    });
    return acc;
  }

  // ---- v1.2 cross-gear planning -------------------------------------
  // Gear label for a support mod, from its pool Type (the loadout
  // slot a player would put it on). Unknown/weapon-specific types
  // fall back to the type string itself.
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
  // Plan specific cross-gear mods for the FINISHED build (a report-
  // layer computation — the plan never feeds back into the search).
  // o = {crossGear, focusCounts {set: n}, focusNames {name: 1},
  //      legacySupport {set: n} | null, focusTypes {type: 1},
  //      excludedMods {name: 1}}
  // Candidate sets: >= 1 focus piece, or a set named by a cross-gear
  // include. Selection per set (name asc): includes first, then the
  // set's remaining members (name asc), until focus + legacy support
  // + planned reaches the set's largest published size
  // (numUpgradesInSet, else member count). A member is never planned
  // when it is excluded (by global ban or the cross-gear exclude
  // list), when its set is excluded, when it already sits on the
  // focus item, or when its Type belongs to the focus item's own
  // pool (that is the focus solve's business, not cross-gear).
  function crossGearPlan(ctx, o) {
    var plan = [], plannedBySet = {}, notes = [];
    if (!o.crossGear) return { plan: plan, plannedBySet: plannedBySet, notes: notes };
    var excludeSetNames = {}, excludeModNames = {};
    (Array.isArray(o.crossGear.exclude) ? o.crossGear.exclude : [])
      .forEach(function (x) {
        if (typeof x !== 'string') return;
        if (ctx.setBonuses[x]) excludeSetNames[x] = 1;
        excludeModNames[x] = 1; // the same string may also name a mod
      });
    var includeBySet = {};
    (Array.isArray(o.crossGear.include) ? o.crossGear.include : [])
      .forEach(function (inc) {
        var name = inc && inc.mod;
        if (!name || typeof name !== 'string') return;
        var set = ctx.setOfMod[name];
        if (!set) {
          notes.push('Cross-gear include ' + name + ' skipped: it belongs to no set.');
          return;
        }
        if (excludeSetNames[set] || excludeModNames[name] || o.excludedMods[name]) {
          notes.push('Cross-gear include ' + name + ' skipped: it is excluded.');
          return;
        }
        if (o.focusNames[name]) return; // already on the focus item
        var t = crossGearModType(ctx, name);
        if (t && o.focusTypes[t]) return; // belongs to the focus solve
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

  // ---- v1.2 per-stat breakdown (frames) -----------------------------
  // Contributor chain per stat, in application order: Base -> aura ->
  // normal mods in slot order -> exilus -> arcanes -> shards (grouped
  // per colour/tier/stat pick) -> Tome -> Helminth subsume -> legacy
  // helmet -> Set bonuses. Each prefix is re-scored with the solver's
  // own contributions + achievedFrom (set bonuses suppressed until
  // the final step, where they land as one entry). A source appears
  // in a stat's chain only when it moves that stat. cumulative values
  // are round2; the final entry equals the reported achieved value.
  function frameBreakdown(ctx, frame, state, routes, supportSetPieces,
                          orderedMods, exilusName, helmetFrame) {
    var chains = {};
    // v1.5: channelDrain joins the chains when the frame tracks a
    // channel (its chain derives from the same prefix evaluations —
    // the contributors are the Efficiency/Duration movers).
    var bdStats = ctx.channelTrack
      ? ALL_STATS.concat(['channelDrain']) : ALL_STATS;
    bdStats.forEach(function (s) { chains[s] = []; });
    function achievedOf(st, noSet) {
      return achievedFrom(ctx, frame,
        walkContributions(ctx, st, routes, supportSetPieces, null, noSet));
    }
    var prefix = emptyState(null);
    prefix._helmetFrame = helmetFrame || state._helmetFrame;
    // v1.5 Focus: contributions ride on ctx, not on the prefix
    // state, so the chain replays them as explicit steps — start
    // from none and add one node at a time (restored before the
    // final full evaluation below; ctx is per-solve, so this is
    // safe). Conditional focus nodes the route excludes simply
    // produce no delta and drop out of the chain, like any
    // conditional piece.
    var focusAll = ctx.focusActive || [];
    var focusSoFar = [];
    ctx.focusActive = [];
    var prev = achievedOf(prefix, true);
    bdStats.forEach(function (s) {
      chains[s].push({ source: 'Base', kind: 'base', cumulative: round2(prev[s]) });
    });
    var steps = [];
    if (state.aura) {
      steps.push({ source: state.aura, kind: 'aura',
        apply: function (p) { p.aura = state.aura; } });
    }
    (orderedMods || []).forEach(function (n) {
      if (state.mods[n] == null) return;
      steps.push({ source: n, kind: 'mod',
        apply: function (p) { p.mods[n] = state.mods[n]; } });
    });
    if (exilusName && state.exilusMod) {
      steps.push({ source: exilusName, kind: 'exilus',
        apply: function (p) {
          p.exilusMod = { name: state.exilusMod.name, rank: state.exilusMod.rank };
        } });
    }
    (state.arcanes || []).forEach(function (n) {
      steps.push({ source: n, kind: 'arcane',
        apply: function (p) { p.arcanes.push(n); } });
    });
    var groups = [], gidx = {};
    (state.shards || []).forEach(function (sh) {
      var k = sh.colour + '|' + sh.tier + '|' + sh.stat;
      if (!(k in gidx)) {
        gidx[k] = groups.length;
        groups.push({ sh: sh, count: 0, items: [] });
      }
      groups[gidx[k]].count++;
      groups[gidx[k]].items.push(sh);
    });
    groups.forEach(function (g) {
      var label = (g.sh.tier === 'tauforged' ? 'Tauforged ' : '') +
        g.sh.colour + ' Archon Shard' + (g.count > 1 ? ' ×' + g.count : '');
      steps.push({ source: label, kind: 'shard',
        apply: function (p) {
          g.items.forEach(function (sh) { p.shards.push(sh); });
        } });
    });
    if (state.tome) {
      steps.push({ source: state.tome, kind: 'tome',
        apply: function (p) { p.tome = state.tome; } });
    }
    if (state.subsume) {
      steps.push({ source: state.subsume.ability, kind: 'subsume',
        apply: function (p) { p.subsume = state.subsume; } });
    }
    if (state.helmet) {
      steps.push({ source: state.helmet, kind: 'helmet',
        apply: function (p) { p.helmet = state.helmet; } });
    }
    focusAll.forEach(function (node) {
      steps.push({ source: 'Focus · ' + node.school + ' — ' + node.name,
        kind: 'focus', focusNode: node,
        apply: function (p) { /* focus rides on ctx, see loop */ } });
    });
    steps.forEach(function (step) {
      if (step.focusNode) {
        focusSoFar.push(step.focusNode);
        ctx.focusActive = focusSoFar.slice();
      }
      step.apply(prefix);
      var now = achievedOf(prefix, true);
      bdStats.forEach(function (s) {
        if (Math.abs(now[s] - prev[s]) > 1e-9) {
          chains[s].push({ source: step.source, kind: step.kind,
                           cumulative: round2(now[s]) });
        }
      });
      prev = now;
    });
    // Final step: set bonuses land (full contribution walk).
    ctx.focusActive = focusAll;
    var full = achievedOf(state, false);
    bdStats.forEach(function (s) {
      if (Math.abs(full[s] - prev[s]) > 1e-9) {
        chains[s].push({ source: 'Set bonuses', kind: 'set',
                         cumulative: round2(full[s]) });
      }
    });
    // v1.2.1: each entry also carries its own increase over the
    // previous entry (the Base entry's delta is its own value), so
    // the chain reads "+delta -> running total" per source and the
    // deltas sum to the final cumulative.
    bdStats.forEach(function (s) {
      var prevCum = 0;
      chains[s].forEach(function (e, i) {
        e.delta = (i === 0) ? e.cumulative : round2(e.cumulative - prevCum);
        prevCum = e.cumulative;
      });
    });
    return chains;
  }

  // Split input.targets into hard targets (atleast/closest/dontcare,
  // solved by the beam search exactly as before) and Maximize entries
  // (v1.1: mode 'maximize', optional numeric `priority`; default
  // priority is the order the stats were given). Maximize stats are
  // raised afterwards by the fill phase, lexicographically by
  // priority — they never enter the beam's scoring.
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

  // Normalise a caller-supplied mod record (derived mods_effects
  // shape, or an already solver-shaped record) into a pool record.
  // Unlike modRecord() this ALLOWS zero mapped effects — a locked mod
  // with no solver stats (e.g. Primed Sure Footed) still occupies its
  // slot and drains capacity (v1.1 locks).
  function lockRecordNormalize(raw, nameHint) {
    if (!raw) return null;
    var maxRank = raw.maxRank || 0;
    var effs = [];
    (raw.effects || []).forEach(function (e) {
      if (!e) return;
      if (e.upgradeType) {
        var stat = UT_TO_STAT[e.upgradeType];
        if (!stat || (e.unit !== 'percent' && e.unit !== 'flat')) return;
        effs.push({
          stat: stat, unit: e.unit,
          valuePerRank: (typeof e.valuePerRank === 'number')
            ? e.valuePerRank : (e.value || 0) / (maxRank + 1),
          condition: e.condition || null
        });
      } else if (e.stat) {
        effs.push({
          stat: e.stat, unit: e.unit || 'percent',
          valuePerRank: (typeof e.valuePerRank === 'number')
            ? e.valuePerRank : (e.value || 0) / (maxRank + 1),
          condition: e.condition || null
        });
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
      restrictedTo: raw.restrictedTo || null,       // v1.4
      augmentsAbility: raw.augmentsAbility || null, // v1.4
      effects: effs
    };
  }

  // v1.5: the frame's tracked channel — the HIGHEST-drain channeled
  // ability among its native abilities (frame.Abilities from the
  // store), or null. Held per-solve on ctx (never shared state).
  function channelTrackFor(ctx, frame) {
    var abilities = (frame && frame.Abilities) || [];
    var best = null;
    abilities.forEach(function (name) {
      var rec = ctx.channelByAbility[name];
      if (rec && typeof rec.baseDrainPerSec === 'number' &&
          (!best || rec.baseDrainPerSec > best.baseDrainPerSec)) {
        best = { ability: name, baseDrainPerSec: rec.baseDrainPerSec,
                 resource: rec.resource || 'energy',
                 note: rec.note || null };
      }
    });
    return best;
  }

  // v1.5: the modelled Focus nodes of one school (ctx.focusBySchool
  // order = dataset order), optionally narrowed to a kept-name list.
  // null when the school has no modelled nodes at all.
  function focusActiveFor(ctx, school, keepNames) {
    var nodes = ctx.focusBySchool[school] || null;
    if (!nodes) return null;
    if (!keepNames) return nodes.slice();
    return nodes.filter(function (n) { return keepNames.indexOf(n.name) >= 0; });
  }

  function achievedFrom(ctx, frame, sums) {
    var out = {};
    ABILITY_STATS.forEach(function (k) { out[k] = 100 + sums[k].percent; });
    // v1.6.1: a lock effect (Arcane Sculptor) SETS the efficiency
    // outright — before the channel read and the cap below, so
    // the uncapped efficiency the drain formula reads IS the
    // lock value (which can be BELOW the summed value: the lock
    // reduces such a build, it does not add to it).
    if (typeof sums.abilityEfficiency.lock === 'number') {
      out.abilityEfficiency = sums.abilityEfficiency.lock;
    }
    // v1.5 channel drain (see header): the formula reads the TRUE
    // efficiency BEFORE the cast cap below is applied, and the
    // build's duration; multiplier clamped to [0.25, 1.75] of base.
    if (ctx.channelTrack) {
      var effRaw = out.abilityEfficiency;
      var durPct = out.abilityDuration;
      var mult = durPct > 0 ? (200 - effRaw) / durPct : 1.75;
      mult = Math.max(0.25, Math.min(1.75, mult));
      out.channelDrain = ctx.channelTrack.baseDrainPerSec * mult;
    }
    out.abilityEfficiency = Math.min(EFFICIENCY_CAP, out.abilityEfficiency);
    POOL_STATS.forEach(function (k) {
      var baseKey = { health: 'Health', shield: 'Shield', armor: 'Armor', energyMax: 'Energy' }[k];
      var base = frame[baseKey] || 0;
      out[k] = base * (1 + sums[k].percent / 100) + sums[k].flat;
    });
    return out;
  }

  // ---- capacity / forma fitting ----------------------------------------------
  // Aura capacity bonus (wiki "Aura"): an aura GRANTS capacity equal
  // to its drain magnitude (|baseDrain| + maxRank, e.g. 7 for most
  // auras) — doubled when the aura slot's polarity matches, the plain
  // magnitude in an unpolarized slot, and 80% of the magnitude rounded
  // DOWN in a slot of a different polarity. Aura mods of polarity
  // 'Any' always count as matching. slotPol === undefined reads the
  // frame's innate AuraPolarity; callers pass the EFFECTIVE polarity
  // instead (v1.5.3): a Forma-purchased polarity, or 'Omni' when the
  // build's Omni Forma toggle is on ('Universal' — the polarity
  // picker's name for the same thing — is treated identically).
  // Pre-v1.5.3 the mismatch branch HALVED the bonus (floor(mag/2)) —
  // an invented rule, never wiki-checked; it made Tacusin's Follie +
  // Growing Power build read capacity 63 where the game reads 65.
  function auraCapacityBonus(ctx, frame, auraName, slotPol) {
    if (!auraName) return 0;
    var a = ctx.auraByName[auraName];
    if (!a) return 0;
    var mag = Math.abs(a.baseDrain) + a.maxRank; // aura drain magnitude at max rank
    var framePol = slotPol === undefined ? (frame.AuraPolarity || null) : slotPol;
    if (a.polarity === 'Any') return mag * 2;
    if (framePol === 'Omni' || framePol === 'Universal') return mag * 2; // universal match
    if (framePol && a.polarity === framePol) return mag * 2; // matching doubles
    if (!framePol || framePol === 'None') return mag;       // no slot polarity: neutral
    return Math.floor(mag * 0.8);                            // mismatch: 80%, rounded down
  }

  function modDrainAt(mod, rank) { return mod.baseDrain + rank; }

  // v1.6.0 (#14): the game's polarity-mismatch drain penalty (wiki
  // "Polarity"): a mod in a slot of a DIFFERENT polarity costs
  // ceil(drain * 1.25). A match halves (ceil(drain/2)) — a
  // 'Universal' (Omni Forma) slot matches everything EXCEPT Umbra,
  // and an Umbra mod there is NOT a mismatch either (full drain,
  // no penalty; the #17 ruling). No slot polarity and no mod
  // polarity both price at full drain. This helper is the single
  // pricing rule for fit slotInfo and evaluateFrame's given mode;
  // fitCapacity's counting applies the same rule through its seat
  // accounting (see there).
  function drainInSlot(d, slotPol, modPol) {
    if (d <= 0) return d;
    var sp = (slotPol && slotPol !== 'None') ? slotPol : null;
    var mp = (modPol && modPol !== 'None') ? modPol : null;
    if (sp && mp && (sp === mp || (sp === 'Universal' && mp !== 'Umbra'))) {
      return Math.ceil(d / 2);
    }
    if (sp && mp && sp !== 'Universal') return Math.ceil(d * 1.25);
    return d;
  }

  // Fit chosen mods to the frame's capacity under the POLARITY POOL
  // model (v1.5.1, Tacusin's mechanic): once a slot is forma'd its
  // polarity is freely swappable among the non-aura slots, so a build
  // owns a pool = the frame's innate polarities + one polarity per
  // forma spent. The fit is therefore counted from the pool, not from a
  // slot assignment: (1) free matches — per polarity, the biggest-drain
  // mods of that polarity up to the innate count (polarities never
  // compete, so biggest-first per polarity is optimal); (2) forma spend
  // — remaining unmatched mods, biggest saving first (saving = drain −
  // ceil(drain/2)), each forma adds that mod's polarity to the pool and
  // matches it, until capacity fits or the budget runs out. The exilus
  // mod participates in the forma spend but is never free-matched (its
  // slot has no innate polarity). umbraForma (default 0) is a SEPARATE
  // budget: only it can match an Umbra-polarity mod. Slot PLACEMENT is
  // derived after counting (slotInfo shape unchanged): free-matched
  // mods into innate slots of their polarity, forma'd mods into the
  // remaining slots preferring non-innate ones, leftovers ascending;
  // the exilus mod stays pinned to the exilus slot.
  // v1.5.3: the AURA slot stays out of the pool (it never swaps), but
  // its polarity is spendable state of its own. auraOpts.omniAura (the
  // build's Omni Forma toggle) makes the slot a universal match —
  // bonus x2 for any aura — and the Omni Forma counts as 1 in the
  // returned formaUsed total (Tacusin's correction: an Omni Forma is
  // still a Forma), though it is never charged against formaBudget
  // (the toggle is a user declaration, like a lock). Otherwise the fit may BUY
  // the match with 1 regular Forma: the purchase is a capacity-side
  // candidate inside the regular forma pass below, competing on gain
  // (2*mag - current bonus) against the mods' drain savings, spent
  // only while the fit is invalid and budget remains — the fit's
  // existing spend-only-while-invalid discipline. Exact gain ties
  // keep mods first (the aura candidate is appended last and the sort
  // is stable). The outcome rides the return as auraBonus /
  // auraSlotPolarity / auraFormaUsed / auraOmni.
  // v1.6.0 (#14): the fit's cost is PRICED, not summed — see
  // pricedCost below. Unmatched mods are no longer automatically
  // full drain: arranged optimally over the remaining seats, a
  // polarized leftover that cannot avoid a polarized seat pays the
  // game's +25% mismatch penalty (drainInSlot). The spend loops
  // therefore run on pricedCost(), recomputed after every spend.
  function fitCapacity(ctx, frame, state, formaBudget, reactor, umbraForma, auraOpts) {
    // Necramech/Companion items carry _slotCount/_baseCapacity markers
    // (set in solve): their capacity is rank-cap based, not reactor based.
    var slotCount = frame._slotCount || 8;
    var auraRec = state.aura ? ctx.auraByName[state.aura] : null;
    var auraMag = auraRec ? Math.abs(auraRec.baseDrain) + auraRec.maxRank : 0;
    var auraOmni = !!(auraOpts && auraOpts.omniAura && auraRec);
    var auraBonus = auraCapacityBonus(ctx, frame, state.aura,
      auraOmni ? 'Omni' : undefined);
    var auraSlotPolarity = auraOmni ? 'Omni' : (frame.AuraPolarity || null);
    var auraFormaUsed = 0;
    var capacityMax = (typeof frame._baseCapacity === 'number'
      ? frame._baseCapacity : (reactor ? 60 : 30)) + auraBonus;
    var slotPols = (frame.Polarities || []).slice(0, slotCount);
    while (slotPols.length < slotCount) slotPols.push(null);

    var chosen = Object.keys(state.mods).map(function (name) {
      return { name: name, mod: ctx.modByName[name], rank: state.mods[name] };
    });
    // Exilus slot: one extra slot with NO innate polarity, appended
    // after the normal slots. The exilus mod is pinned to it.
    var exEntry = null;
    if (state.exilusMod) {
      var exMod = ctx.modByName[state.exilusMod.name];
      if (exMod) exEntry = { name: state.exilusMod.name, mod: exMod, rank: state.exilusMod.rank };
    }
    var all = exEntry ? chosen.concat([exEntry]) : chosen.slice();

    function polOf(c) {
      var p = c.mod.polarity;
      return (p && p !== 'None') ? p : null;
    }
    function drainOf(c) { return modDrainAt(c.mod, c.rank); }
    function savingOf(c) { var d = drainOf(c); return d - Math.ceil(d / 2); }
    // Deterministic candidate order: biggest saving, then biggest
    // drain, then name — never input order.
    function bySaving(a, b) {
      return (savingOf(b) - savingOf(a)) || (drainOf(b) - drainOf(a)) ||
             (a.name < b.name ? -1 : 1);
    }
    function byDrain(a, b) {
      return (drainOf(b) - drainOf(a)) || (a.name < b.name ? -1 : 1);
    }

    var matched = {};                       // modName -> true
    var matchedFree = [], matchedForma = [], matchedUmbra = [];

    // v1.6.0 (#14): the PRICED cost of the current matched sets,
    // applying drainInSlot's rule through seat accounting. Seats
    // (normal slots only — the exilus mod is pinned to its own
    // unpolarized slot and can only match there via Forma): the
    // innate polarized seats and the null seats are both finite.
    // Free matches consume polarized seats; Forma/Umbra matches
    // consume seats null-first (the placement's preference).
    // Leftover mods then arrange to minimise the penalty:
    // polarity-less leftovers take polarized seats, the biggest
    // polarized leftovers take the remaining null seats, and only
    // the smallest polarized leftovers that cannot avoid a
    // polarized seat pay ceil(drain * 1.25) instead of drain.
    // (A remaining polarized seat's polarity never equals a
    // leftover mod's polarity — every mod of that polarity was
    // free-matched first — so any polarized seat a polarized
    // leftover takes is a genuine mismatch.)
    var polarizedSeats = 0;
    slotPols.forEach(function (p) { if (p && p !== 'None') polarizedSeats++; });
    var nullSeats = slotCount - polarizedSeats;
    function pricedCost() {
      var total = 0, saved = 0;
      all.forEach(function (c) {
        total += drainOf(c);
        if (matched[c.name]) saved += savingOf(c);
      });
      var fSeat = 0;
      matchedForma.concat(matchedUmbra).forEach(function (n) {
        if (!exEntry || n !== exEntry.name) fSeat++;
      });
      var nullAfter = nullSeats - Math.min(fSeat, nullSeats);
      var polAfter = polarizedSeats - matchedFree.length -
        Math.max(0, fSeat - nullSeats);
      var lp = [], lz = 0;
      chosen.forEach(function (c) {
        if (matched[c.name]) return;
        if (polOf(c)) lp.push(drainOf(c)); else lz++;
      });
      lp.sort(function (a, b) { return a - b; });
      var safeNull = nullAfter - Math.max(0, lz - polAfter);
      var penCount = Math.max(0, lp.length - Math.max(0, safeNull));
      var extra = 0;
      for (var pi = 0; pi < penCount; pi++) {
        extra += Math.ceil(lp[pi] * 1.25) - lp[pi];
      }
      return total - saved + extra;
    }

    // (1) Free matches from the innate pool (normal slots only).
    var pool = {};
    slotPols.forEach(function (p) { if (p) pool[p] = (pool[p] || 0) + 1; });
    var byPol = {};
    chosen.forEach(function (c) {
      var p = polOf(c);
      if (p) (byPol[p] = byPol[p] || []).push(c);
    });
    Object.keys(byPol).forEach(function (p) {
      var list = byPol[p].slice().sort(byDrain);
      var n = Math.min(pool[p] || 0, list.length);
      for (var i = 0; i < n; i++) {
        matched[list[i].name] = true;
        matchedFree.push(list[i].name);
      }
    });

    // (2) Forma spend, then the Umbra Forma pass (separate budget).
    // v1.5.3: the aura-match purchase rides this same pass as one
    // extra candidate (see the header note): its gain is the bonus
    // increase (2*mag - current bonus), positive exactly when the
    // innate slot is neutral or mismatched and the aura is not
    // 'Any'-polarity (those already match for free).
    var budget = (formaBudget === 'any' || formaBudget == null) ? Infinity : formaBudget;
    var regularUsed = 0;
    var formaCands = all.filter(function (c) {
      return !matched[c.name] && polOf(c) && polOf(c) !== 'Umbra' && savingOf(c) > 0;
    }).sort(bySaving);
    var spend = formaCands.map(function (c) { return { cand: c, gain: savingOf(c) }; });
    if (!auraOmni && auraRec && auraRec.polarity !== 'Any' &&
        auraMag * 2 - auraBonus > 0) {
      spend.push({ aura: true, gain: auraMag * 2 - auraBonus });
    }
    // Stable sort by gain desc: formaCands arrive in bySaving order,
    // so mods keep their order among themselves, and the aura
    // candidate (appended last) loses exact ties to mods.
    spend.sort(function (a, b) { return b.gain - a.gain; });
    for (var fi = 0; fi < spend.length && pricedCost() > capacityMax && regularUsed < budget; fi++) {
      var sp2 = spend[fi];
      if (sp2.aura) {
        capacityMax += sp2.gain;
        auraBonus = auraMag * 2;
        auraSlotPolarity = auraRec.polarity;
        auraFormaUsed = 1;
      } else {
        matched[sp2.cand.name] = true;
        matchedForma.push(sp2.cand.name);
      }
      regularUsed++;
    }
    var umbraBudget = umbraForma || 0;
    var umbraUsedCount = 0;
    var umbraCands = all.filter(function (c) {
      return !matched[c.name] && polOf(c) === 'Umbra' && savingOf(c) > 0;
    }).sort(bySaving);
    for (var ui = 0; ui < umbraCands.length && pricedCost() > capacityMax && umbraUsedCount < umbraBudget; ui++) {
      matched[umbraCands[ui].name] = true;
      matchedUmbra.push(umbraCands[ui].name);
      umbraUsedCount++;
    }

    // (3) Derived placement. Slot indices: 0..slotCount-1 normal, plus
    // slotCount for the exilus slot when present.
    var innatePols = exEntry ? slotPols.concat([null]) : slotPols.slice();
    var pols = innatePols.slice();
    var assign = {}; // modName -> slotIndex
    var taken = {};
    function freeSlots(filter) {
      var out = [];
      for (var i = 0; i < slotCount; i++) {
        if (!taken[i] && filter(i)) out.push(i);
      }
      return out;
    }
    if (exEntry) { assign[exEntry.name] = slotCount; taken[slotCount] = true; }
    var byName = {};
    all.forEach(function (c) { byName[c.name] = c; });
    // Free-matched mods into innate slots of their polarity.
    matchedFree.slice().sort(function (a, b) { return byDrain(byName[a], byName[b]); })
      .forEach(function (name) {
        var c = byName[name];
        var slots = freeSlots(function (i) { return innatePols[i] === polOf(c); });
        if (slots.length) { assign[name] = slots[0]; taken[slots[0]] = true; }
      });
    // Forma'd mods (incl. Umbra) into remaining slots, non-innate first.
    matchedForma.concat(matchedUmbra).forEach(function (name) {
      var c = byName[name];
      if (name === (exEntry && exEntry.name)) { pols[slotCount] = polOf(c); return; }
      var slots = freeSlots(function (i) { return !innatePols[i]; });
      if (!slots.length) slots = freeSlots(function () { return true; });
      if (slots.length) {
        assign[name] = slots[0]; taken[slots[0]] = true;
        pols[slots[0]] = polOf(c);
      }
    });
    // Leftover mods into the remaining slots, arranged to minimise
    // the v1.6.0 mismatch penalty (mirrors pricedCost's accounting):
    // polarity-less leftovers take polarized seats, the biggest
    // polarized leftovers take the remaining unpolarized seats, and
    // only the smallest polarized leftovers end up in polarized
    // seats — the penalised set. The exilus mod is already pinned.
    var leftovers = all.filter(function (c) { return !(c.name in assign); });
    function takeSlot(c, pred) {
      var slots = freeSlots(pred);
      if (!slots.length) slots = freeSlots(function () { return true; });
      if (slots.length) { assign[c.name] = slots[0]; taken[slots[0]] = true; }
    }
    leftovers.filter(function (c) { return !polOf(c); }).forEach(function (c) {
      takeSlot(c, function (i) { return !!innatePols[i]; });
    });
    leftovers.filter(function (c) { return polOf(c); }).sort(byDrain)
      .forEach(function (c) {
        takeSlot(c, function (i) { return !innatePols[i]; });
      });

    var formaPlan = [];
    matchedForma.forEach(function (name) {
      if (name in assign) formaPlan.push({ slot: assign[name], polarity: polOf(byName[name]) });
    });
    matchedUmbra.forEach(function (name) {
      if (name in assign) formaPlan.push({ slot: assign[name], polarity: 'Umbra', umbra: true });
    });
    // Per-slot outcome (v1.1): the single source of truth the slot
    // list is derived from — which mod sits in which slot, the slot's
    // final polarity, and the mod's effective drain there.
    var bySlot = {};
    all.forEach(function (c) { if (c.name in assign) bySlot[assign[c.name]] = c; });
    var planBySlot = {};
    formaPlan.forEach(function (p) { planBySlot[p.slot] = p; });
    var slotInfo = innatePols.map(function (innate, i) {
      var c = bySlot[i] || null;
      var planEntry = planBySlot[i] || null;
      return {
        slot: i,
        mod: c ? c.name : null,
        rank: c ? c.rank : null,
        polarity: pols[i],
        innatePolarity: innate,
        formaApplied: !!planEntry,
        umbraFormaApplied: !!(planEntry && planEntry.umbra),
        effectiveDrain: c ? drainInSlot(drainOf(c), pols[i], polOf(c)) : 0
      };
    });
    var finalCost = pricedCost();
    return {
      capacityUsed: finalCost,
      capacityMax: capacityMax,
      // +1 when the Omni toggle is on: the Omni Forma itself (see
      // the header note) — counted in the total, not in the budget.
      formaUsed: regularUsed + (auraOmni ? 1 : 0),
      umbraFormaUsed: umbraUsedCount,
      formaPlan: formaPlan,
      valid: finalCost <= capacityMax,
      assign: assign,
      pols: pols,
      slotInfo: slotInfo,
      matched: { free: matchedFree, forma: matchedForma, umbra: matchedUmbra },
      // v1.5.3: the aura slot's outcome (see the header note).
      auraBonus: auraBonus,
      auraSlotPolarity: auraSlotPolarity,
      auraFormaUsed: auraFormaUsed,
      auraOmni: auraOmni
    };
  }

  // ---- scoring ------------------------------------------------------------------
  function scoreState(targets, achieved, fit, state, opts) {
    var shortfall = 0, closestDist = 0;
    Object.keys(targets).forEach(function (stat) {
      var t = targets[stat];
      if (!t || t.mode === 'dontcare' || typeof t.value !== 'number') return;
      var a = achieved[stat];
      if (t.mode === 'atleast') {
        // v1.5 Q2: channelDrain is lower-better — 'atleast' reads
        // "at or below" (lowerBetter convention, as weaponSolver).
        if (stat === 'channelDrain' && t.lowerBetter !== false) {
          if (a > t.value) {
            shortfall += (a - t.value) / Math.max(1, Math.abs(t.value));
          }
        } else if (a < t.value) shortfall += (t.value - a) / t.value;
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
    // v1.5.1 Stage B (spare the shards): with the preference on, each
    // shard in the build carries a flat 0.05 score weight — sized
    // ABOVE the whole tertiary economy (a shard otherwise costs
    // 0.002-0.004 against 0.012+ per mod and 0.01 per Forma, so
    // shard-spending lanes win every close trade by default), which
    // makes lanes that cover targets with mods + Forma outrank lanes
    // that spend shards. It stays far below the target terms (a 1%
    // shortfall step = 100 points; a 1% closest step = 1; five
    // shards max = 0.25), so a shard is still spent whenever mods +
    // Forma within the Forma budget cannot meet a target, or a
    // closest target gains more than the weight buys elsewhere.
    // Preference, never prohibition.
    if (opts && opts.spareShards) score += state.shards.length * 0.05;
    // v1.5 channel preference: an ORDERING bias only (see header) —
    // present solely while a channelDrain target is scored, sized to
    // outrank the tertiary economy term but never a target term.
    if (opts && opts.prefStat && targets.channelDrain &&
        typeof targets.channelDrain.value === 'number') {
      score -= (achieved[opts.prefStat] || 0) * 0.001;
    }
    if (!fit.valid) score += 20000; // search must prefer valid arrangements
    return { score: score, shortfall: shortfall, closestDist: closestDist };
  }

  // ---- item resolution ---------------------------------------------------------
  // Item kind: 'warframe' (default), 'necramech', 'companion'. The
  // non-frame kinds reuse this solver with their own base-stat entry,
  // mod pool, slot count and capacity rule. Shared by solve() and
  // evaluateFrame() so both resolve items identically. Mutates ctx:
  // swaps modPool/modByName to the kind's pool.
  function resolveItem(ctx, input) {
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
    return { kind: kind, frame: frame };
  }

  // ---- solver ---------------------------------------------------------------------
  function solve(input, data) {
    var ctx = buildContext(data);
    var resolved = resolveItem(ctx, input);
    var kind = resolved.kind;
    var frame = resolved.frame;
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
      helminth: !!routesIn.helminth,          // DEFAULT OFF, same caution
      augments: !!routesIn.augments           // v1.4: DEFAULT OFF — gates augment locks only (see header)
    };
    if (kind !== 'warframe') {
      routes.arcanes = false; routes.shards = false; routes.aura = false;
      routes.exilus = false; routes.tome = false; routes.legacyHelmets = false;
      routes.helminth = false;
    }
    // ---- v1.3 build intent -------------------------------------------------
    // input.intent ('window' | 'upkeep') is consulted ONLY when the
    // conditional route is on; with it off (or intent 'window' /
    // absent) the solve is byte-identical to v1.2. 'upkeep' prunes
    // burst-class pieces (Stage 1 classes) from every candidate
    // pool below — search AND fill share buildCandidates. Locks and
    // a forced Helminth choice override the pruning (explicit
    // player direction) and are flagged in the result notes.
    var intent = routes.conditional ? (input.intent || null) : null;
    var pruneBurst = intent === 'upkeep';
    function isBurst(name) { return isBurstPiece(ctx, name); }
    // ---- v1.4 hybrid intent ----------------------------------------
    // 'hybrid' = upkeep discipline with a burst allowance: burst
    // candidates stay in the pools, but expand()/fillPhase() reject
    // any state whose SOLVER-CHOSEN burst count exceeds the
    // allowance. Locked burst pieces and a forced Helminth subsume
    // do NOT consume the allowance (Q1, resolved in the checklist:
    // locks override pruning outright, so they sit outside it).
    var hybrid = intent === 'hybrid';
    var burstAllowance = hybrid ? burstAllowanceOf(input) : 0;
    // v1.1: Maximize targets split off — the beam solves the hard
    // targets (atleast/closest) exactly as before; Maximize stats are
    // raised afterwards by the fill phase (see fillPhase below).
    var split = splitTargets(input.targets);
    var targets = split.hard;
    var maximizeList = split.maximize;
    var targetedStats = Object.keys(targets).filter(function (s) {
      return targets[s] && targets[s].mode !== 'dontcare' && typeof targets[s].value === 'number';
    });

    // ---- v1.5 channel drain -----------------------------------------
    // Tracked channel for THIS frame (warframe kind only; native
    // abilities only — see header). ctx.channelTrack feeds
    // achievedFrom, so evaluateWith / breakdown / sustained all see
    // channelDrain with no further plumbing.
    ctx.channelTrack = kind === 'warframe' ? channelTrackFor(ctx, frame) : null;
    var channelNotes = [];
    if (!ctx.channelTrack && targets.channelDrain) {
      // A drain target on a frame with no tracked channel is dropped
      // with a note (warn-never-block): there is no drain to solve
      // toward. (The site never offers the control there.)
      delete targets.channelDrain;
      targetedStats = targetedStats.filter(function (s) {
        return s !== 'channelDrain';
      });
      channelNotes.push('Channel drain target ignored: ' + input.frameName +
        ' has no channeled ability with a documented per-second drain.');
    }
    if (maximizeList.some(function (m) { return m.stat === 'channelDrain'; })) {
      // Maximize on a drain is meaningless (lower is better) and is
      // not offered by the site; drop it with a note rather than let
      // the fill phase RAISE a drain.
      maximizeList = maximizeList.filter(function (m) {
        return m.stat !== 'channelDrain';
      });
      channelNotes.push('Maximize is not supported for Channel drain ' +
        '(lower is better); the entry was ignored.');
    }
    var channelTargeted = !!ctx.channelTrack &&
      targetedStats.indexOf('channelDrain') >= 0;
    var channelPreference = input.channelPreference === 'duration'
      ? 'duration' : 'efficiency';
    // Q2 (see header): 'atleast' on channelDrain reads "at or below"
    // — the lowerBetter convention from weaponSolver.js, defaulting
    // true for this stat, overridable per target.
    function lowerBetter(stat) {
      if (stat !== 'channelDrain') return false;
      var t = targets[stat];
      if (t && typeof t.lowerBetter === 'boolean') return t.lowerBetter;
      return true;
    }
    // Preference bias plumbing for scoreState: each field is present
    // ONLY while its preference is active (invariance contract —
    // with neither active, scoreOpts stays null and every score is
    // byte-identical to the pre-preference engine).
    // v1.5.1 Stage B: spare-the-shards is a warframe-kind preference
    // (shards are a frame route; the other kinds never field shards,
    // so the flag is inert for them even if passed).
    var spareShards = kind === 'warframe' && !!input.spareShards;
    var scoreOpts = null;
    if (channelTargeted || spareShards) {
      scoreOpts = {};
      if (channelTargeted) {
        scoreOpts.prefStat = channelPreference === 'duration'
          ? 'abilityDuration' : 'abilityEfficiency';
      }
      if (spareShards) scoreOpts.spareShards = true;
    }

    // ---- v1.5 Focus school route --------------------------------
    // input.routes.focus = {school} picks ONE school (warframe kind
    // only). Its modelled nodes become fixed route contributions on
    // ctx.focusActive (see header): unconditional nodes always
    // apply; conditional nodes count under the conditional route.
    // Intent: burst-class focus nodes are PRUNED under upkeep
    // (noted), KEPT under hybrid without consuming the allowance
    // (the school is the player's explicit pick — Q1's player-pinned
    // class), and stripped again for the sustained floor.
    var focusNotes = [];
    var focusSchoolApplied = null;
    var focusKeptNodes = [];
    var focusPick = (kind === 'warframe' && routesIn.focus &&
      typeof routesIn.focus === 'object' &&
      typeof routesIn.focus.school === 'string' && routesIn.focus.school)
      ? routesIn.focus.school : null;
    if (focusPick) {
      var focusKnown = !!ctx.focusCounts[focusPick] ||
        (data.focus && (data.focus.schools || []).some(function (s) {
          return s && s.name === focusPick;
        }));
      if (!focusKnown) {
        throw new Error('Unknown focus school: ' + focusPick +
          ' (dataset schools: ' +
          Object.keys(ctx.focusCounts).sort().join(', ') + ')');
      }
      focusSchoolApplied = focusPick;
      var focusAllNodes = focusActiveFor(ctx, focusPick) || [];
      var focusKept = focusAllNodes;
      if (pruneBurst) {
        focusKept = focusAllNodes.filter(function (n) {
          if (isBurst(n.name)) {
            focusNotes.push('Focus node ' + n.name + ' (' + focusPick +
              ') is a burst piece and is excluded from an upkeep build.');
            return false;
          }
          return true;
        });
      } else if (hybrid) {
        focusAllNodes.forEach(function (n) {
          if (isBurst(n.name)) {
            focusNotes.push('Focus node ' + n.name + ' (' + focusPick +
              ') is a burst piece kept under Hybrid — the school is ' +
              'your explicit pick, so it does not consume the burst ' +
              'allowance.');
          }
        });
      }
      ctx.focusActive = focusKept;
      focusKeptNodes = focusKept.map(function (n) { return n.name; });
      var fc = ctx.focusCounts[focusPick] || { modelled: 0, prose: 0, operatorOnly: 0 };
      focusNotes.push('Focus school: ' + focusPick + ' — ' +
        (focusKeptNodes.length
          ? 'modelled nodes applied: ' + focusKeptNodes.join(', ') +
            ' (conditional ones count under the Conditional route).'
          : 'no stat-modelled nodes are active for this school.') +
        ' The school\'s other ' + (fc.prose + fc.operatorOnly) +
        ' nodes are mechanic or Operator effects and are not ' +
        'stat-modelled (see the Focus audit).');
    }

    // ---- v1.2 excludes ---------------------------------------------------
    // input.excludedMods / input.excludedArcanes ban pieces from
    // every candidate pool (search AND fill, incl. tome/aura picks
    // and cross-gear planning). A piece that is both locked and
    // excluded is a contradiction — hard Error, raised in the lock
    // loops below.
    var excludedModSet = {}, excludedArcaneSet = {};
    (Array.isArray(input.excludedMods) ? input.excludedMods : []).forEach(function (n) {
      if (typeof n === 'string') excludedModSet[n] = 1;
    });
    (Array.isArray(input.excludedArcanes) ? input.excludedArcanes : []).forEach(function (n) {
      if (typeof n === 'string') excludedArcaneSet[n] = 1;
    });
    // Pool Types the focus item itself can hold (v1.2 cross-gear:
    // set members of these types belong to the focus solve, never
    // to the cross-gear plan). Aura picks are focus-side for frames.
    var focusTypeSet = {};
    ctx.modPool.forEach(function (m) { if (m.type) focusTypeSet[m.type] = 1; });
    if (kind === 'warframe') focusTypeSet.Aura = 1;

    // ---- v1.1 locks ------------------------------------------------------
    // input.lockedMods = [{name, rank}] must appear in the build at
    // the player's rank; input.lockedArcanes = [name] occupy arcane
    // slots the same way. Locks are seeded into the start states and
    // the search never drops or re-ranks them (the capacity trim pass
    // after the search is the single exception, and it reports).
    // Records resolve from the kind's pool, then the derived store,
    // then input.extraModRecords — the last two let callers lock
    // stat-less mods (e.g. Primed Sure Footed) that the stat model
    // does not carry.
    var lockedModNames = [], lockedNameSet = {}, lockedRanks = {};
    function resolveLockRecord(name) {
      if (ctx.modByName[name]) return ctx.modByName[name];
      var raw = null;
      (ctx.derivedMods || []).forEach(function (m) { if (m.name === name) raw = m; });
      if (!raw && input.extraModRecords) raw = input.extraModRecords[name];
      if (!raw) {
        throw new Error('Unknown locked mod: ' + name +
          ' (not in the mod pool or the derived store; pass its record via extraModRecords)');
      }
      var rec = lockRecordNormalize(raw, name);
      ctx.modByName[name] = rec;
      if (rec.set) ctx.setOfMod[name] = rec.set;
      return rec;
    }
    // ---- v1.4 augment lock context ----------------------------------
    // Eligibility is computed from the frame's native abilities and
    // the Helminth choice AS PASSED (the forced-choice block below
    // validates it properly when the helminth route is on; with the
    // route off the choice is inert — v1.2 contract — and confers
    // no eligibility). Dropped augment locks collect notes here and
    // are pushed into result.notes after the build (warn-never-
    // block — the lock simply does not apply).
    var frameAbilitiesEarly = (kind === 'warframe' && frame &&
      Array.isArray(frame.Abilities)) ? frame.Abilities : [];
    var eligChoice = (routes.helminth && input.helminthChoice)
      ? { donor: input.helminthChoice.donor,
          replacesIndex: input.helminthChoice.replacesIndex } : null;
    var augmentLockNotes = [];
    function augmentDropNote(rec, name) {
      var why;
      if (rec.augmentsAbility) {
        if (eligChoice &&
            frameAbilitiesEarly[eligChoice.replacesIndex] === rec.augmentsAbility) {
          why = 'its ability (' + rec.augmentsAbility +
            ') is the one the Helminth choice replaces';
        } else {
          why = input.frameName + ' does not currently have ' +
            rec.augmentsAbility + ' (native or subsumed)';
        }
      } else {
        why = 'it has no extracted ability link, so it is restricted ' +
          'to its native frame (' + rec.restrictedTo + ')';
      }
      return 'Locked ' + name + ' is an ability augment that is not ' +
        'eligible on ' + input.frameName + ': ' + why +
        '. The lock was not applied.';
    }
    (Array.isArray(input.lockedMods) ? input.lockedMods : []).forEach(function (L) {
      var name = L && L.name;
      if (!name) throw new Error('lockedMods entries need a name.');
      if (excludedModSet[name]) {
        throw new Error('Mod ' + name + ' is both locked and excluded.');
      }
      if (lockedNameSet[name]) throw new Error('Duplicate locked mod: ' + name);
      var rec = resolveLockRecord(name);
      // v1.4: ability augments — the Augments route gates them, and
      // eligibility follows the ability (see augmentEligible). A
      // dropped augment lock never reaches the seed lists below.
      if (kind === 'warframe' && isAugmentRecord(rec)) {
        if (!routes.augments) {
          augmentLockNotes.push('Locked ' + name + ' is an ability ' +
            'augment, but augments are off — the lock was not applied ' +
            '(enable the Augments route to include locked augments).');
          return;
        }
        if (!augmentEligible(rec, input.frameName, eligChoice, frameAbilitiesEarly)) {
          augmentLockNotes.push(augmentDropNote(rec, name));
          return;
        }
      }
      var wantType = kind === 'warframe' ? 'Warframe'
        : kind === 'necramech' ? 'Necramech' : null;
      if (wantType && rec.type && rec.type !== wantType) {
        throw new Error('Locked mod ' + name + ' is a ' + rec.type +
          ' mod and cannot be locked onto a ' + kind + ' build.');
      }
      if (kind === 'companion' && rec.type && ctx._companionTypes &&
          !ctx._companionTypes[rec.type]) {
        throw new Error('Locked mod ' + name + ' is a ' + rec.type +
          ' mod and cannot be locked onto this companion.');
      }
      // v1.4: a restricted piece locked onto the wrong companion is
      // the same class of error as a wrong-type lock (exact match).
      if (kind === 'companion' && rec.restrictedTo &&
          rec.restrictedTo !== input.frameName) {
        throw new Error('Locked mod ' + name + ' is restricted to ' +
          rec.restrictedTo + ' and cannot be locked onto ' +
          input.frameName + '.');
      }
      lockedNameSet[name] = true;
      lockedModNames.push(name);
      lockedRanks[name] = (typeof L.rank === 'number')
        ? Math.max(0, Math.min(rec.maxRank, Math.round(L.rank))) : rec.maxRank;
    });
    var lockedArcaneNames = [];
    var gatedArcaneNotes = [];
    (Array.isArray(input.lockedArcanes) ? input.lockedArcanes : []).forEach(function (name) {
      if (excludedArcaneSet[name]) {
        throw new Error('Arcane ' + name + ' is both locked and excluded.');
      }
      if (lockedArcaneNames.indexOf(name) >= 0) {
        throw new Error('Duplicate locked arcane: ' + name);
      }
      if (lockedArcaneNames.length >= 2) {
        throw new Error('At most 2 arcanes can be locked (the item has 2 arcane slots).');
      }
      if (ctx.arcaneNames.length && ctx.arcaneNames.indexOf(name) < 0) {
        throw new Error('Unknown locked arcane: ' + name);
      }
      // v1.6.1: an ability-gated arcane (Arcane Sculptor) locked
      // onto a frame whose effective abilities — native plus the
      // forced Helminth choice, the augment-lock precedent — hold
      // no listed ability is dropped with a note, never fielded.
      var gatedEntry = ctx.arcaneByName[name];
      if (kind === 'warframe' && gatedEntry && gatedEntry.validAbilities &&
          !arcaneEligibleChoice(gatedEntry, eligChoice, frameAbilitiesEarly)) {
        gatedArcaneNotes.push('Locked ' + name + ' is ability-gated: ' +
          input.frameName + ' does not currently have any of its ' +
          'qualifying abilities (native or subsumed). The lock was ' +
          'not applied.');
        return;
      }
      lockedArcaneNames.push(name);
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

    // Candidate pieces touching a given stat set. Built twice: HARD
    // (the hard targets — drives the beam search, exactly the v1.0
    // behaviour) and FILL (the Maximize stats — drives the fill
    // phase; its rank sets add each mod's half-contribution rank).
    // (baseFrameName is module-level since v1.4 — augmentEligible
    // shares the same Prime normalisation.)
    var frameAbilities = (kind === 'warframe' && frame && Array.isArray(frame.Abilities))
      ? frame.Abilities : [];
    var abilityLocks = Array.isArray(input.abilityLocks) ? input.abilityLocks : [];
    // ---- v1.2 Helminth forced choice -----------------------------------
    // input.helminthChoice = {donor, replacesIndex} pins the exact
    // subsume the player picked. It is seeded into every start state
    // (see lockedStartStates), so the beam's auto-pick can never add
    // a different or additional subsume. Only meaningful with the
    // helminth route on; with the route off the choice is inert.
    var forcedChoice = null;
    if (input.helminthChoice && routes.helminth) {
      var hc = input.helminthChoice;
      var donorEntry = null;
      ctx.helminthAll.forEach(function (e) {
        if (e.ability === hc.donor) donorEntry = e;
      });
      if (!donorEntry) {
        throw new Error('Unknown helminth donor: ' + hc.donor +
          ' (not a subsumable ability in the Helminth dataset).');
      }
      if (baseFrameName(donorEntry.frame) === baseFrameName(input.frameName)) {
        throw new Error('Helminth donor ' + hc.donor + ' is from ' +
          input.frameName + "'s own family — a frame cannot subsume its own ability.");
      }
      var ri = hc.replacesIndex;
      if (typeof ri !== 'number' || ri % 1 !== 0 || ri < 0 || ri > 3) {
        throw new Error('helminthChoice.replacesIndex must be an integer 0..3, got ' +
          JSON.stringify(ri) + '.');
      }
      if (abilityLocks[ri]) {
        throw new Error('helminthChoice replaces ability ' + (ri + 1) +
          ' (' + (frameAbilities[ri] || 'unknown') +
          '), but that ability is locked and can never be replaced.');
      }
      var replacedName = frameAbilities[ri] || ('Ability ' + (ri + 1));
      forcedChoice = {
        donor: donorEntry.ability, donorFrame: donorEntry.frame,
        replacesIndex: ri, replacesAbility: replacedName,
        diminishedText: donorEntry.diminishedText,
        modelled: ctx.helminth.some(function (e) { return e.ability === donorEntry.ability; })
      };
    }
    var helmetListAll = routes.legacyHelmets
      ? (ctx.legacyHelmets[input.frameName] || []) : [];
    function fillRanks(mod) {
      var set = {};
      candidateRanks(mod).forEach(function (r) { set[r] = true; });
      set[mod.maxRank] = true;
      mod.effects.forEach(function (e) {
        var isMax = maximizeList.some(function (m) { return m.stat === e.stat; });
        if (!isMax || (e.condition && !routes.conditional)) return;
        var total = e.valuePerRank * (mod.maxRank + 1);
        if (!(total > 0)) return;
        for (var r = 0; r <= mod.maxRank; r++) {
          if (e.valuePerRank * (r + 1) >= total / 2) { set[r] = true; break; }
        }
      });
      return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }
    function buildCandidates(statSet, ranksFn, unfilteredHelmets) {
      var mods = [];
      if (routes.mods) {
        ctx.modPool.forEach(function (mod) {
          if (excludedModSet[mod.name]) return; // v1.2 ban
          if (mod.restrictedTo && mod.restrictedTo !== input.frameName) return; // v1.4 restricted: its item only
          if (pruneBurst && isBurst(mod.name)) return; // v1.3 upkeep
          var touches = mod.effects.some(function (e) {
            return statSet.indexOf(e.stat) >= 0 && (!e.condition || routes.conditional);
          });
          if (touches) mods.push({ mod: mod, ranks: ranksFn(mod) });
        });
      }
      var arcanes = routes.arcanes ? ctx.arcanes.filter(function (a) {
        return !excludedArcaneSet[a.name] && // v1.2 ban
               !(pruneBurst && isBurst(a.name)) && // v1.3 upkeep
               a.effects.some(function (e) { return statSet.indexOf(e.stat) >= 0; }) &&
               (!a.conditional || routes.conditional);
      }) : [];
      // Helminth subsume candidates (S3): dataset entries with
      // modelled effects touching the stat set, donor excluded by
      // base-name family (a frame — or its Prime — can never receive
      // its own ability). At most one subsume, replacing one
      // UNLOCKED ability.
      var subsumes = (routes.helminth && frameAbilities.length) ? ctx.helminth.filter(function (e) {
        if (baseFrameName(e.frame) === baseFrameName(input.frameName)) return false;
        if (pruneBurst && isBurst(e.ability)) return false; // v1.3 upkeep
        return e.effects.some(function (ef) {
          return statSet.indexOf(ef.stat) >= 0 && (!ef.conditional || routes.conditional);
        });
      }) : [];
      var tomes = (routes.tome && routes.conditional) ? ctx.tomes.filter(function (t) {
        return !excludedModSet[t.name] && // v1.2 ban
               !(pruneBurst && isBurst(t.name)) && // v1.3 upkeep
               statSet.indexOf(t.stat) >= 0;
      }) : [];
      var auras = routes.aura ? ctx.auras.filter(function (a) {
        return !excludedModSet[a.name] && // v1.2 ban (aura names are mod names)
               !(pruneBurst && isBurst(a.name)) && // v1.3 upkeep
               a.effects.some(function (e) {
          return statSet.indexOf(e.stat) >= 0 && (!e.conditional || routes.conditional);
        });
      }) : [];
      var shardPicks = routes.shards ? ctx.shardPicks.filter(function (p) {
        return statSet.indexOf(p.stat) >= 0;
      }) : [];
      var helmets = unfilteredHelmets ? helmetListAll.slice()
        : helmetListAll.filter(function (h) {
            return h.effects.some(function (e) { return statSet.indexOf(e.stat) >= 0; });
          });
      var byName = {};
      mods.forEach(function (c) { byName[c.mod.name] = c; });
      return { mods: mods, arcanes: arcanes, subsumes: subsumes, tomes: tomes,
               auras: auras, shardPicks: shardPicks, helmets: helmets, byName: byName };
    }
    // v1.5: a channelDrain target admits the pieces that FEED the
    // drain — Efficiency and Duration movers — into the hard pool
    // even when those stats are not themselves targeted (admission
    // is by targeted stat; candidateRanks gives the feeders
    // max-rank candidates, which is what drain solving wants).
    var hardStatSet = targetedStats.slice();
    if (channelTargeted) {
      ['abilityEfficiency', 'abilityDuration'].forEach(function (s) {
        if (hardStatSet.indexOf(s) < 0) hardStatSet.push(s);
      });
    }
    var HARD = buildCandidates(hardStatSet, candidateRanks, true);
    var FILL = maximizeList.length
      ? buildCandidates(maximizeList.map(function (m) { return m.stat; }), fillRanks, false)
      : null;

    // v1.4 hybrid: the SOLVER-CHOSEN burst pieces in a state — every
    // burst piece except the ones the player pinned (locked mods,
    // locked arcanes, a forced Helminth subsume), which sit outside
    // the allowance per Q1. Helmets/shards are unclassified (v1.3
    // carried-forward) and never counted.
    function solverBurstNames(st) {
      var out = [];
      Object.keys(st.mods).forEach(function (n) {
        if (!lockedNameSet[n] && isBurst(n)) out.push(n);
      });
      if (st.exilusMod && !lockedNameSet[st.exilusMod.name] &&
          isBurst(st.exilusMod.name)) out.push(st.exilusMod.name);
      if (st.aura && isBurst(st.aura)) out.push(st.aura);
      st.arcanes.forEach(function (n) {
        if (lockedArcaneNames.indexOf(n) < 0 && isBurst(n)) out.push(n);
      });
      if (st.tome && isBurst(st.tome)) out.push(st.tome);
      if (st.subsume && isBurst(st.subsume.ability) &&
          !(forcedChoice && st.subsume.ability === forcedChoice.donor)) {
        out.push(st.subsume.ability);
      }
      return out;
    }
    function solverBurstCount(st) { return solverBurstNames(st).length; }

    function evaluateWith(state, scoreFn) {
      var sums = contributions(ctx, state, routes, input.supportSetPieces);
      var achieved = achievedFrom(ctx, frame, sums);
      var fit = fitCapacity(ctx, frame, state, input.formaBudget,
                            input.reactor !== false, input.umbraForma || 0,
                            input.omniAura ? { omniAura: true } : null);
      var sc = scoreFn(targets, achieved, fit, state, scoreOpts);
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

    function expand(state, cand) {
      var out = [];
      // Mods — normal slots. Exilus-flagged mods may also sit here.
      if (Object.keys(state.mods).length < slotLimit) {
        cand.mods.forEach(function (c) {
          if (!canPlace(state, c.mod)) return;
          c.ranks.forEach(function (r) {
            var ns = clone(state); ns.mods[c.mod.name] = r; out.push(ns);
          });
        });
      }
      // Exilus slot — exilus-flagged mods only, only when the route is on.
      if (routes.exilus && !state.exilusMod) {
        cand.mods.forEach(function (c) {
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
        cand.arcanes.forEach(function (a) {
          if (state.arcanes.indexOf(a.name) >= 0) return;
          // v1.6.1: a gated arcane (Arcane Sculptor) can only be
          // fielded while the state's effective abilities —
          // including a subsume already chosen in this state —
          // include one of its listed abilities.
          if (!arcaneEligibleOn(a, effectiveAbilities(frameAbilities, state.subsume))) return;
          var ns = clone(state); ns.arcanes.push(a.name); out.push(ns);
        });
      }
      // Tome (single pick)
      if (!state.tome) {
        cand.tomes.forEach(function (t) {
          var ns = clone(state); ns.tome = t.name; out.push(ns);
        });
      }
      // Aura (single pick)
      if (!state.aura) {
        cand.auras.forEach(function (a) {
          var ns = clone(state); ns.aura = a.name; out.push(ns);
        });
      }
      // Legacy helmets — one candidate move per helmet in the frame's
      // list; still at most one helmet total, no slot / no capacity cost.
      if (!state.helmet && cand.helmets.length) {
        cand.helmets.forEach(function (h) {
          var ns = clone(state);
          ns.helmet = h.helmetName;
          ns._helmetFrame = input.frameName;
          out.push(ns);
        });
      }
      // Helminth subsume (S3): at most one; each candidate may replace
      // any one UNLOCKED ability slot (locked abilities never move).
      if (!state.subsume && cand.subsumes.length) {
        cand.subsumes.forEach(function (e) {
          frameAbilities.forEach(function (ab, idx) {
            if (abilityLocks[idx]) return;
            // v1.6.1: a subsume that replaces the only qualifying
            // ability would orphan a gated arcane already held in
            // this state (Arcane Sculptor) — reject the move.
            var orphansGate = state.arcanes.some(function (n) {
              var ga = ctx.arcaneByName[n];
              return ga && ga.validAbilities &&
                !arcaneEligibleOn(ga, effectiveAbilities(frameAbilities,
                  { ability: e.ability, replacedAbility: ab }));
            });
            if (orphansGate) return;
            var ns = clone(state);
            ns.subsume = { ability: e.ability, fromFrame: e.frame, replacedAbility: ab };
            out.push(ns);
          });
        });
      }
      // Shards (max 5)
      if (state.shards.length < 5) {
        cand.shardPicks.forEach(function (p) {
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
      // v1.4 hybrid: the burst allowance caps SOLVER-CHOSEN burst
      // pieces per build (locks ride in the start states and are
      // excluded from the count — see solverBurstNames).
      if (hybrid) {
        return out.filter(function (ns) {
          return solverBurstCount(ns) <= burstAllowance;
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
    // Deficit lanes (v1.1): alongside the stratified top scorers, keep
    // a few states that sit BELOW an at-least floor but hold the
    // highest gross positive contribution toward that floor's stat —
    // the corrupted-mod compensation pattern (a big upside paired
    // with a negative on the same stat reads as a bad score until a
    // second piece compensates). Bound: at most 2 extra states per
    // at-least stat, at most 6 extra states per round, chosen from
    // the 6 closest-from-below states per stat.
    var DEFICIT_PER_STAT = 2, DEFICIT_TOTAL = 6, DEFICIT_POOL = 6;
    function sigOf(ev) {
      if (!ev._sig) ev._sig = stateSignature(ev.state);
      return ev._sig;
    }
    function grossFor(ev, stat) {
      var g = grossPositive(ctx, ev.state, routes, input.supportSetPieces, stat);
      if (ABILITY_STATS.indexOf(stat) >= 0) return g.percent;
      var baseKey = { health: 'Health', shield: 'Shield', armor: 'Armor', energyMax: 'Energy' }[stat];
      return (frame[baseKey] || 0) * g.percent / 100 + g.flat;
    }
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
          var sig = sigOf(ev);
          if (!picked[sig]) { picked[sig] = true; out.push(ev); }
        });
      });
      for (var i = 0; i < sorted.length && out.length < BEAM; i++) {
        var sig2 = sigOf(sorted[i]);
        if (!picked[sig2]) { picked[sig2] = true; out.push(sorted[i]); }
      }
      // Deficit lanes (see bound above).
      var extraBudget = DEFICIT_TOTAL;
      for (var si = 0; si < targetedStats.length && extraBudget > 0; si++) {
        var stat = targetedStats[si];
        var t = targets[stat];
        if (!t || t.mode !== 'atleast') continue;
        // v1.5: channelDrain sits ABOVE its "floor" by construction
        // (lower-better) — the below-floor lane logic does not apply.
        if (stat === 'channelDrain') continue;
        var below = sorted.filter(function (ev) {
          return !picked[sigOf(ev)] && ev.achieved[stat] < t.value - 1e-9;
        });
        if (!below.length) continue;
        below.sort(function (a, b) { return b.achieved[stat] - a.achieved[stat]; });
        var cands = below.slice(0, DEFICIT_POOL).map(function (ev) {
          return { ev: ev, gross: grossFor(ev, stat) };
        });
        cands.sort(function (a, b) { return b.gross - a.gross; });
        cands.slice(0, Math.min(DEFICIT_PER_STAT, extraBudget)).forEach(function (c) {
          var sig = sigOf(c.ev);
          if (!picked[sig]) { picked[sig] = true; out.push(c.ev); extraBudget--; }
        });
      }
      return out.sort(function (a, b) { return a.score - b.score; });
    }

    // Beam search. Termination: run until a round generates no new
    // states, or the round cap. Do NOT stop on a top-score plateau —
    // slow lanes (many small pieces, e.g. the 0-mod shard path)
    // complete after the beam's top score has already flattened on a
    // fast lane's solution. startStates (v1.1) seeds the beam — the
    // lock placements; defaults to the single empty state.
    function runSearch(scoreFn, startStates) {
      var beam = startStates.map(function (s) { return evaluateWith(s, scoreFn); });
      var bestValidEver = null;
      function consider(ev) {
        if (!ev.fit.valid) return;
        if (!bestValidEver || ev.score < bestValidEver.score) bestValidEver = ev;
      }
      beam.forEach(consider);
      for (var round = 0; round < 22; round++) {
        var seen = {};
        var next = [];
        var newCount = 0;
        beam.forEach(function (ev) { seen[stateSignature(ev.state)] = true; next.push(ev); });
        beam.forEach(function (ev) {
          expand(ev.state, HARD).forEach(function (ns) {
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
      return { ev: finals[0] || beam[0], fellBack: true };
    }

    // Lock-seeded start states: every locked mod placed at its locked
    // rank, locked arcanes occupying their slots. For each
    // exilus-eligible locked mod there is an extra start variant with
    // that mod in the exilus slot (the solver picks the placement);
    // the base variant keeps all locks in normal slots.
    function lockedStartStates() {
      function seeded(exilusLockName) {
        var st = emptyState(input.shardWallet);
        st._helmetFrame = input.frameName;
        lockedModNames.forEach(function (n) {
          if (n === exilusLockName) st.exilusMod = { name: n, rank: lockedRanks[n] };
          else st.mods[n] = lockedRanks[n];
        });
        st.arcanes = lockedArcaneNames.slice();
        // v1.2: a forced Helminth choice rides in every start state;
        // expand() only adds a subsume to a state that has none, so
        // the auto-pick can never override or stack on it. A
        // non-modelled donor simply never matches a ctx.helminth
        // entry in the contribution walk — no stat effect.
        if (forcedChoice) {
          st.subsume = {
            ability: forcedChoice.donor, fromFrame: forcedChoice.donorFrame,
            replacedAbility: forcedChoice.replacesAbility
          };
        }
        return st;
      }
      // Exilus variants come FIRST: on an exact score tie the search
      // keeps the earliest-evaluated state, so an exilus-eligible
      // lock lands in the free exilus slot unless a normal-slot
      // placement scores strictly better (e.g. an innate match).
      var starts = [];
      if (routes.exilus && kind === 'warframe' &&
          lockedModNames.length <= slotLimit + 1) {
        lockedModNames.forEach(function (n) {
          var rec = ctx.modByName[n];
          if (rec && rec.exilus && Object.keys(seeded(n).mods).length <= slotLimit) {
            starts.push(seeded(n));
          }
        });
      }
      if (lockedModNames.length <= slotLimit) starts.push(seeded(null));
      if (!starts.length) {
        throw new Error('Too many locked mods: ' + lockedModNames.length +
          ' locks for ' + slotLimit + ' slots' +
          (routes.exilus ? ' + exilus' : '') + '.');
      }
      return starts;
    }

    var mainRun = runSearch(scoreState, lockedStartStates());
    var chosenEv = mainRun.ev;

    // ---- v1.1 lock capacity trim -------------------------------------
    // The search never re-ranks a locked mod. If NO valid fitting
    // exists at the locked ranks, trim locked ranks (largest drain
    // first) to the highest ranks that fit, and report each trim.
    var trimNotes = [];
    if (lockedModNames.length && !chosenEv.fit.valid) {
      var rankIn = function (st, n) {
        if (st.mods[n] != null) return st.mods[n];
        if (st.exilusMod && st.exilusMod.name === n) return st.exilusMod.rank;
        return null;
      };
      var setRankIn = function (st, n, r) {
        if (st.mods[n] != null) st.mods[n] = r;
        else if (st.exilusMod && st.exilusMod.name === n) st.exilusMod.rank = r;
      };
      var tst = clone(chosenEv.state);
      var beforeRanks = {};
      lockedModNames.forEach(function (n) { beforeRanks[n] = rankIn(tst, n); });
      var tev = chosenEv, trimGuard = 0;
      while (!tev.fit.valid && trimGuard++ < 500) {
        var pickName = null, pickDrain = -1;
        lockedModNames.forEach(function (n) {
          var r = rankIn(tst, n);
          if (r == null || r <= 0) return;
          var d = modDrainAt(ctx.modByName[n], r);
          if (d > pickDrain) { pickDrain = d; pickName = n; }
        });
        if (!pickName) break;
        setRankIn(tst, pickName, rankIn(tst, pickName) - 1);
        tev = evaluateWith(tst, scoreState);
      }
      lockedModNames.forEach(function (n) {
        var after = rankIn(tst, n);
        if (after != null && beforeRanks[n] != null && after < beforeRanks[n]) {
          trimNotes.push('Locked ' + n + ' rank reduced ' + beforeRanks[n] +
            '→' + after + ' to fit capacity');
        }
      });
      if (trimNotes.length) chosenEv = tev;
    }

    // ---- v1.1 fill phase ----------------------------------------------
    // From the best target arrangement, spend ONLY leftover resources
    // (empty slots, spare capacity, leftover Forma incl. Umbra rules,
    // unspent wallet shards, free arcane slots) to raise the Maximize
    // stats lexicographically by priority. A fill move is accepted
    // only if it does not worsen ANY target outcome vs the anchor
    // (at-least floors stay met / no worse, closest distances do not
    // grow) and strictly improves the Maximize vector. Greedy:
    // each iteration takes the single best move (vector first, then
    // fewest new slots, then lowest added drain).
    function maximizeVector(ach) {
      return maximizeList.map(function (m) { return ach[m.stat]; });
    }
    function vecGreater(a, b) {
      for (var i = 0; i < a.length; i++) {
        if (a[i] > b[i] + 1e-9) return true;
        if (a[i] < b[i] - 1e-9) return false;
      }
      return false;
    }
    function guardOk(evNew, anchor) {
      for (var i = 0; i < targetedStats.length; i++) {
        var stat = targetedStats[i], t = targets[stat];
        if (t.mode === 'atleast' && lowerBetter(stat)) {
          // v1.5 Q2 mirrored: a met drain cap stays met; an unmet
          // one never gets worse under fill.
          if (anchor.achieved[stat] <= t.value + 1e-9) {
            if (evNew.achieved[stat] > t.value + 1e-9) return false;
          } else if (evNew.achieved[stat] > anchor.achieved[stat] + 1e-9) return false;
        } else if (t.mode === 'atleast') {
          if (anchor.achieved[stat] >= t.value - 1e-9) {
            if (evNew.achieved[stat] < t.value - 1e-9) return false;
          } else if (evNew.achieved[stat] < anchor.achieved[stat] - 1e-9) return false;
        } else if (t.mode === 'closest') {
          if (Math.abs(evNew.achieved[stat] - t.value) >
              Math.abs(anchor.achieved[stat] - t.value) + 1e-9) return false;
        }
      }
      return true;
    }
    // Fill-only move shapes the add-only expander cannot express:
    // rank-ups of placed (non-locked) mods and replacements of a
    // placed (non-locked) mod by a Maximize candidate.
    function fillExtraMoves(state) {
      var out = [];
      Object.keys(state.mods).forEach(function (name) {
        if (lockedNameSet[name]) return;
        var c = FILL.byName[name];
        if (c) c.ranks.forEach(function (r) {
          if (r > state.mods[name]) {
            var ns = clone(state); ns.mods[name] = r; out.push(ns);
          }
        });
      });
      if (state.exilusMod && !lockedNameSet[state.exilusMod.name]) {
        var ce = FILL.byName[state.exilusMod.name];
        if (ce) ce.ranks.forEach(function (r) {
          if (r > state.exilusMod.rank) {
            var ns = clone(state); ns.exilusMod.rank = r; out.push(ns);
          }
        });
      }
      Object.keys(state.mods).forEach(function (nameA) {
        if (lockedNameSet[nameA]) return;
        FILL.mods.forEach(function (c) {
          if (c.mod.name === nameA) return;
          var base = clone(state);
          delete base.mods[nameA];
          if (!canPlace(base, c.mod)) return;
          c.ranks.forEach(function (r) {
            var ns = clone(base); ns.mods[c.mod.name] = r; out.push(ns);
          });
        });
      });
      if (state.exilusMod && !lockedNameSet[state.exilusMod.name] && routes.exilus) {
        FILL.mods.forEach(function (c) {
          if (!c.mod.exilus || c.mod.name === state.exilusMod.name) return;
          var base = clone(state);
          base.exilusMod = null;
          if (!canPlace(base, c.mod)) return;
          c.ranks.forEach(function (r) {
            var ns = clone(base);
            ns.exilusMod = { name: c.mod.name, rank: r };
            out.push(ns);
          });
        });
      }
      return out;
    }
    function fillPhase(anchorEv) {
      var cur = anchorEv;
      var changed = false;
      for (var iter = 0; iter < 40; iter++) {
        var moves = expand(cur.state, FILL).concat(fillExtraMoves(cur.state));
        var best = null;
        moves.forEach(function (ns) {
          // v1.4 hybrid: fillExtraMoves bypass expand(), so the
          // burst allowance is re-checked here for every move.
          if (hybrid && solverBurstCount(ns) > burstAllowance) return;
          var ev = evaluateWith(ns, scoreState);
          if (!ev.fit.valid) return;
          if (!guardOk(ev, anchorEv)) return;
          if (!vecGreater(maximizeVector(ev.achieved), maximizeVector(cur.achieved))) return;
          var cand = {
            ev: ev,
            slotsDelta: modCount(ns) - modCount(cur.state),
            drainDelta: ev.fit.capacityUsed - cur.fit.capacityUsed
          };
          if (!best) { best = cand; return; }
          var va = maximizeVector(cand.ev.achieved), vb = maximizeVector(best.ev.achieved);
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

    var anchorEv = chosenEv;
    var filledEv = chosenEv, fillChanged = false;
    if (maximizeList.length && FILL && anchorEv.fit.valid) {
      var fillRes = fillPhase(anchorEv);
      filledEv = fillRes.ev;
      fillChanged = fillRes.changed &&
        stateSignature(filledEv.state) !== stateSignature(anchorEv.state);
    }
    chosenEv = filledEv;

    // Piece origins (v1.1): 'target' for pieces the target solve
    // chose (same piece, same rank), 'fill' for anything the fill
    // phase added or re-ranked.
    function computeOrigins(anchorState, finalState) {
      var modOrigin = {};
      Object.keys(finalState.mods).forEach(function (n) {
        modOrigin[n] = (anchorState.mods[n] === finalState.mods[n]) ? 'target' : 'fill';
      });
      if (finalState.exilusMod) {
        modOrigin[finalState.exilusMod.name] =
          (anchorState.exilusMod && anchorState.exilusMod.name === finalState.exilusMod.name &&
           anchorState.exilusMod.rank === finalState.exilusMod.rank) ? 'target' : 'fill';
      }
      function multiset(list, keyFn) {
        var m = {};
        list.forEach(function (x) { var k = keyFn(x); m[k] = (m[k] || 0) + 1; });
        return m;
      }
      var anchorShards = multiset(anchorState.shards, function (s) {
        return s.colour + '|' + s.tier + '|' + s.stat;
      });
      var shardOrigins = finalState.shards.map(function (s) {
        var k = s.colour + '|' + s.tier + '|' + s.stat;
        if (anchorShards[k] > 0) { anchorShards[k]--; return 'target'; }
        return 'fill';
      });
      var anchorArcanes = multiset(anchorState.arcanes, function (n) { return n; });
      var arcaneOrigins = {};
      finalState.arcanes.forEach(function (n) {
        if (anchorArcanes[n] > 0) { anchorArcanes[n]--; arcaneOrigins[n] = 'target'; }
        else arcaneOrigins[n] = 'fill';
      });
      return {
        mods: modOrigin,
        shards: shardOrigins,
        arcanes: arcaneOrigins,
        aura: finalState.aura
          ? (finalState.aura === anchorState.aura ? 'target' : 'fill') : null,
        tome: finalState.tome
          ? (finalState.tome === anchorState.tome ? 'target' : 'fill') : null,
        helmet: finalState.helmet
          ? (finalState.helmet === anchorState.helmet ? 'target' : 'fill') : null,
        subsume: finalState.subsume
          ? (anchorState.subsume && anchorState.subsume.ability === finalState.subsume.ability
             ? 'target' : 'fill') : null
      };
    }
    var origins = fillChanged ? computeOrigins(anchorEv.state, chosenEv.state) : null;

    // Set-bonus report for a finished state: pieces counted across the
    // focus item and cross-gear support pieces. Parsed bonuses that map
    // to a solver stat are already inside `achieved` (see contributions)
    // and are flagged applied here; everything else is reported so a
    // real mechanic is never silently absent from the result.
    function setBonusReport(counts, plannedBySet) {
      var out = [];
      var allSets = {};
      Object.keys(counts).forEach(function (set) { allSets[set] = 1; });
      Object.keys(plannedBySet || {}).forEach(function (set) { allSets[set] = 1; });
      Object.keys(allSets).forEach(function (set) {
        var c = counts[set] || { focus: 0, support: 0 };
        var planned = (plannedBySet && plannedBySet[set]) || 0;
        var sb = ctx.setBonuses[set];
        // v1.2: planned cross-gear pieces count in the totals
        // immediately (Tacusin's decision — support gear is treated
        // as already built); supportPieces keeps the legacy
        // supportSetPieces counts only.
        var pieces = c.focus + c.support + planned;
        if (!sb) {
          out.push({ set: set, pieces: pieces, focusPieces: c.focus,
                     supportPieces: c.support, plannedPieces: planned,
                     parseStatus: 'unknown',
                     perPiece: null, totalValue: null, applied: false, sourceText: '' });
          return;
        }
        var applied = !!(sb.perPiece && sb.perPiece.some(function (pp) {
          return !!UT_TO_STAT[pp.upgradeType];
        }));
        out.push({
          set: set, pieces: pieces, focusPieces: c.focus,
          supportPieces: c.support, plannedPieces: planned,
          parseStatus: sb.parseStatus,
          perPiece: sb.perPiece,
          totalValue: (sb.perPiece && sb.perPiece.length === 1 &&
                       typeof sb.perPiece[0].value === 'number')
            ? sb.perPiece[0].value * pieces : null,
          applied: applied, sourceText: sb.sourceText
        });
      });
      return out.sort(function (a, b) { return a.set < b.set ? -1 : 1; });
    }

    // ---- v1.3 sustained floor ------------------------------------------
    // The final build re-evaluated with burst-class pieces removed,
    // via the forward evaluator on the filtered piece list — no new
    // math. Present only when the build actually uses ≥1 burst
    // piece (mod, exilus, aura, arcane, Tome or subsume); otherwise
    // null. The evaluators themselves stay intent-free: they score
    // the piece list they are given, filtering happens here.
    function sustainedFor(st) {
      var hasBurst = false;
      function keep(name) {
        if (isBurst(name)) { hasBurst = true; return false; }
        return true;
      }
      var slots = [];
      if (st.aura && keep(st.aura)) {
        slots.push({ kind: 'aura', mod: st.aura, rank: null });
      }
      Object.keys(st.mods).forEach(function (n) {
        if (keep(n)) slots.push({ kind: 'normal', mod: n, rank: st.mods[n] });
      });
      if (st.exilusMod && keep(st.exilusMod.name)) {
        slots.push({ kind: 'exilus', mod: st.exilusMod.name, rank: st.exilusMod.rank });
      }
      var keptArcanes = st.arcanes.filter(keep);
      var keptTome = (st.tome && keep(st.tome)) ? st.tome : null;
      var keptSubsume = st.subsume || null;
      if (keptSubsume && !keep(keptSubsume.ability)) keptSubsume = null;
      // v1.5: focus nodes ride outside the slot state — strip the
      // burst ones the same way (a burst focus node alone is enough
      // to make the floor meaningful).
      var keptFocus = null;
      if (focusSchoolApplied) {
        keptFocus = {
          school: focusSchoolApplied,
          nodes: focusKeptNodes.filter(keep)
        };
      }
      if (!hasBurst) return null;
      var ev = evaluateFrame(data, input.frameName, {
        slots: slots, arcanes: keptArcanes,
        shards: st.shards.map(function (s) {
          return { colour: s.colour, tier: s.tier, stat: s.stat };
        }),
        tome: keptTome, helmet: st.helmet || null, subsume: keptSubsume,
        focus: keptFocus,
        conditional: routes.conditional,
        // v1.5.3: the floor's fit prices the aura slot exactly like
        // the peak's (same toggle; the purchase discipline re-runs
        // on the filtered state).
        omniAura: !!input.omniAura,
        formaBudget: input.formaBudget, umbraForma: input.umbraForma || 0,
        reactor: input.reactor, itemKind: input.itemKind,
        companionEntry: input.companionEntry, ownerStats: input.ownerStats,
        supportSetPieces: input.supportSetPieces,
        extraModRecords: input.extraModRecords
      });
      return { achieved: ev.achieved, breakdown: ev.breakdown };
    }

    function buildResult(evRes, org) {
      var st = evRes.state;
      var rNotes = [];
      var originOf = function (n) {
        return (org && org.mods && org.mods[n]) || 'target';
      };
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
      // v1.5: the tracked channel's drain joins the reported stats.
      if (ctx.channelTrack && typeof evRes.achieved.channelDrain === 'number') {
        achieved.channelDrain = round2(evRes.achieved.channelDrain);
      }

      var unmet = [];
      targetedStats.forEach(function (stat) {
        var t = targets[stat];
        if (t.mode !== 'atleast') return;
        // v1.5 Q2 mirrored: a drain target is unmet when the drain
        // sits ABOVE the cap.
        var missed = lowerBetter(stat)
          ? evRes.achieved[stat] > t.value + 1e-9
          : evRes.achieved[stat] < t.value - 1e-9;
        if (missed) {
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
        if (forcedChoice && !forcedChoice.modelled &&
            st.subsume.ability === forcedChoice.donor) {
          rNotes.push('Helminth subsume (your choice): ' + st.subsume.ability +
            ' (from ' + st.subsume.fromFrame + ') replaces ' +
            st.subsume.replacedAbility + '. This subsume is NOT stat-modelled ' +
            '— it is included as a build instruction only and does not move ' +
            'any paper stat.');
        } else {
          rNotes.push('Helminth subsume: ' + st.subsume.ability + ' (from ' +
            st.subsume.fromFrame + ') replaces ' + st.subsume.replacedAbility +
            '. Modelled effects are the diminished values from the Helminth ' +
            'dataset; conditional effects count under the conditional route.');
        }
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
      // v1.6.1: a fielded lock-effect arcane (Arcane Sculptor)
      // SETS its stat rather than adding to it — name the lock
      // value and the first-cast trap beside the conditional note.
      st.arcanes.forEach(function (n) {
        var la = ctx.arcaneByName[n];
        if (!la) return;
        la.effects.forEach(function (e) {
          if (e.kind !== 'lock') return;
          rNotes.push(n + ': Ability Efficiency is locked at ' + e.value +
            '% while its effect is active — it does not add to other ' +
            'Efficiency sources, and it lowers a build whose summed ' +
            'Efficiency is higher. The cast that creates the object ' +
            'gains no benefit unless the object spawns instantly.');
        });
      });
      // v1.2 cross-gear plan for THIS finished build (main and
      // cheapest each plan from their own final state).
      var pieceCounts = setPieceCounts(ctx, st, input.supportSetPieces);
      var focusNames = {};
      Object.keys(st.mods).forEach(function (n) { focusNames[n] = 1; });
      if (st.exilusMod) focusNames[st.exilusMod.name] = 1;
      if (st.aura) focusNames[st.aura] = 1;
      var focusCounts = {};
      Object.keys(pieceCounts).forEach(function (set) {
        focusCounts[set] = pieceCounts[set].focus;
      });
      var cg = crossGearPlan(ctx, {
        crossGear: input.crossGear || null,
        focusCounts: focusCounts, focusNames: focusNames,
        legacySupport: input.supportSetPieces || null,
        focusTypes: focusTypeSet, excludedMods: excludedModSet
      });
      cg.notes.forEach(function (n) { rNotes.push(n); });
      var report = setBonusReport(pieceCounts, cg.plannedBySet);
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
        return { name: n, rank: rank, slot: slot, rankCost: rc, origin: originOf(n) };
      }
      var costedMods = Object.keys(st.mods).sort().map(function (n) {
        return costedEntry(n, st.mods[n], 'normal');
      }).concat(st.exilusMod ? [costedEntry(st.exilusMod.name, st.exilusMod.rank, 'exilus')] : []);
      if (unknownCost.length) {
        rNotes.push('Ranking cost unknown for ' + unknownCost.join(', ') +
          ' (rarity outside the wiki Fusion page tables); totalRankCost ' +
          'excludes them.');
      }

      // Ordered slot list (v1.1): derived from the fit's slotInfo —
      // the single source of truth for placement, final polarity and
      // effective drain. Aura first (kind 'aura'), then the normal
      // slots in slot order, then the exilus slot when the route is on
      // or a mod sits in it. Aura effectiveDrain is negative: an aura
      // GRANTS capacity instead of draining it.
      var slots = [];
      if (kind === 'warframe') {
        var aRec = st.aura ? ctx.auraByName[st.aura] : null;
        // v1.5.3: the aura cell reports the fit's outcome — a Forma
        // purchase stamps its polarity + flag; the Omni toggle keeps
        // the stored polarity at innate and rides as omniApplied
        // (the toggle itself is build-level state, not cell state).
        slots.push({
          kind: 'aura', fitSlot: null, mod: st.aura || null,
          rank: aRec ? aRec.maxRank : null,
          slotPolarity: evRes.fit.auraFormaUsed
            ? evRes.fit.auraSlotPolarity : (frame.AuraPolarity || null),
          innatePolarity: frame.AuraPolarity || null,
          formaApplied: !!evRes.fit.auraFormaUsed, umbraFormaApplied: false,
          omniApplied: !!evRes.fit.auraOmni && !!st.aura,
          effectiveDrain: st.aura ? -evRes.fit.auraBonus : 0,
          origin: org ? org.aura : 'target'
        });
      }
      (evRes.fit.slotInfo || []).forEach(function (info) {
        var isExilus = kind === 'warframe' && info.slot === slotLimit;
        slots.push({
          kind: isExilus ? 'exilus' : 'normal', fitSlot: info.slot,
          mod: info.mod, rank: info.rank,
          slotPolarity: info.polarity, innatePolarity: info.innatePolarity,
          formaApplied: info.formaApplied,
          umbraFormaApplied: info.umbraFormaApplied,
          effectiveDrain: info.effectiveDrain,
          origin: info.mod ? originOf(info.mod) : 'target'
        });
      });
      if (kind === 'warframe' && routes.exilus && !st.exilusMod) {
        slots.push({
          kind: 'exilus', fitSlot: slotLimit, mod: null, rank: null,
          slotPolarity: null, innatePolarity: null,
          formaApplied: false, umbraFormaApplied: false,
          effectiveDrain: 0, origin: 'target'
        });
      }
      slots.forEach(function (s, i) { s.index = i; });

      // v1.2 breakdown: contributor chains in slot order (the fit's
      // slotInfo order — the same order the slot list reports).
      var orderedModNames = [];
      (evRes.fit.slotInfo || []).forEach(function (info) {
        if (!info.mod) return;
        if (st.exilusMod && info.slot === slotLimit) return; // exilus steps separately
        orderedModNames.push(info.mod);
      });
      var breakdown = frameBreakdown(ctx, frame, st, routes,
        input.supportSetPieces, orderedModNames,
        st.exilusMod ? st.exilusMod.name : null, input.frameName);
      // v1.2 forced Helminth choice echoes: modelled choices name
      // the replaced ability alongside arrangement.subsume;
      // non-modelled choices ride as an instruction object.
      var subsumeReplaces = (forcedChoice && st.subsume &&
        st.subsume.ability === forcedChoice.donor)
        ? forcedChoice.replacesAbility : null;
      var subsumeInstruction = (forcedChoice && !forcedChoice.modelled &&
        st.subsume && st.subsume.ability === forcedChoice.donor) ? {
          donor: forcedChoice.donor, donorFrame: forcedChoice.donorFrame,
          replacesAbility: forcedChoice.replacesAbility,
          diminishedText: forcedChoice.diminishedText, modelled: false
        } : null;
      // A non-modelled forced subsume is NOT reported in
      // arrangement.subsume (that field means "applied subsume") —
      // subsumeInstruction above carries it instead.
      var arrangementSubsume = subsumeInstruction ? null : (st.subsume ? {
        ability: st.subsume.ability, fromFrame: st.subsume.fromFrame,
        replacedAbility: st.subsume.replacedAbility
      } : null);

      // v1.4 hybrid: name the solver-chosen burst pieces (the
      // window part of the build) and the allowance they used.
      var hybridBurst = hybrid ? solverBurstNames(st) : null;
      if (hybrid) {
        rNotes.push('Hybrid: ' + hybridBurst.length + ' of ' +
          burstAllowance + ' burst pieces used' +
          (hybridBurst.length ? ' — ' + hybridBurst.join(', ') : '') + '.');
      }

      return {
        achieved: achieved,
        // v1.5: the tracked channel this build's drain belongs to
        // (null on frames without one).
        channel: ctx.channelTrack ? {
          ability: ctx.channelTrack.ability,
          baseDrainPerSec: ctx.channelTrack.baseDrainPerSec,
          resource: ctx.channelTrack.resource,
          note: ctx.channelTrack.note
        } : null,
        breakdown: breakdown,
        sustained: sustainedFor(st),
        hybridBurst: hybridBurst,
        crossGearPlan: cg.plan,
        arrangement: {
          mods: costedMods,
          slots: slots,
          origins: org || null,
          aura: st.aura || null,
          arcanes: st.arcanes.slice(),
          shards: st.shards.map(function (s, i) {
            return { colour: s.colour, tier: s.tier, stat: s.stat,
                     origin: org ? org.shards[i] : 'target' };
          }),
          tome: st.tome || null,
          helmet: st.helmet || null,
          subsume: arrangementSubsume,
          subsumeReplaces: subsumeReplaces,
          subsumeInstruction: subsumeInstruction,
          // v1.5: the Focus pick + the modelled nodes this build
          // actually fields (post intent-pruning); null = no school.
          focus: focusSchoolApplied ? {
            school: focusSchoolApplied, nodes: focusKeptNodes.slice()
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

    var result = buildResult(chosenEv, origins);
    if (mainRun.fellBack) {
      result.notes.unshift('No arrangement within the Forma budget fits the mod capacity; showing the best-scoring arrangement, which exceeds capacity.');
    }
    trimNotes.forEach(function (n) { result.notes.push(n); });
    // v1.5: dropped channel targets (no tracked channel / maximize)
    // are reported, never silent.
    channelNotes.forEach(function (n) { result.notes.push(n); });
    // v1.4: augment locks that were dropped (route off / ineligible)
    // are reported, never silent.
    augmentLockNotes.forEach(function (n) { result.notes.push(n); });
    // v1.6.1: ability-gated arcane locks dropped as ineligible
    // ride the same never-silent channel.
    gatedArcaneNotes.forEach(function (n) { result.notes.push(n); });
    // v1.5: Focus school notes (applied set / upkeep pruning /
    // hybrid keeps) ride the same never-silent channel.
    focusNotes.forEach(function (n) { result.notes.push(n); });
    // v1.3: locked (or explicitly chosen) burst pieces kept in an
    // upkeep build are flagged — the lock/choice overrode pruning.
    if (pruneBurst) {
      lockedModNames.forEach(function (n) {
        if (isBurst(n)) {
          result.notes.push('Locked ' + n + ' is a burst piece kept in an upkeep build because it is locked.');
        }
      });
      lockedArcaneNames.forEach(function (n) {
        if (isBurst(n)) {
          result.notes.push('Locked ' + n + ' is a burst piece kept in an upkeep build because it is locked.');
        }
      });
      if (forcedChoice && isBurst(forcedChoice.donor)) {
        result.notes.push('Helminth choice ' + forcedChoice.donor +
          ' is a burst piece kept in an upkeep build because it was explicitly chosen.');
      }
    }
    if (lockedModNames.length || lockedArcaneNames.length) {
      var lockNames = lockedModNames.concat(lockedArcaneNames);
      result.unmetTargets.forEach(function (u) {
        result.notes.push('Locked piece(s) ' + lockNames.join(', ') +
          ' are fixed in this build; with them, ' + u.stat +
          ' tops out at ' + u.achieved + ' (target ' + u.target + ').');
      });
    }
    // v1.1: pieces the fill phase added (origin 'fill'), in kind order.
    result.fillPieces = [];
    if (origins) {
      Object.keys(origins.mods).forEach(function (n) {
        if (origins.mods[n] === 'fill') result.fillPieces.push({ kind: 'mod', name: n });
      });
      Object.keys(origins.arcanes).forEach(function (n) {
        if (origins.arcanes[n] === 'fill') result.fillPieces.push({ kind: 'arcane', name: n });
      });
      origins.shards.forEach(function (o, i) {
        if (o !== 'fill') return;
        var sh = chosenEv.state.shards[i];
        result.fillPieces.push({ kind: 'shard', name: sh.colour + ' Archon Shard' });
      });
      if (origins.aura === 'fill') result.fillPieces.push({ kind: 'aura', name: chosenEv.state.aura });
      if (origins.tome === 'fill') result.fillPieces.push({ kind: 'tome', name: chosenEv.state.tome });
      if (origins.helmet === 'fill') result.fillPieces.push({ kind: 'helmet', name: chosenEv.state.helmet });
      if (origins.subsume === 'fill' && chosenEv.state.subsume) {
        result.fillPieces.push({ kind: 'subsume', name: chosenEv.state.subsume.ability });
      }
      result.notes.push('Fill phase (Maximize: ' +
        maximizeList.map(function (m) { return m.stat; }).join(', ') +
        ') spent leftover slots/capacity/Forma on ' + result.fillPieces.length +
        ' piece(s): ' + result.fillPieces.map(function (p) { return p.name; }).join(', ') +
        '. The pre-fill build is reported as the cheapest variant.');
    }
    // Cheapest (v1.1 redefinition): the NO-FILL solve (targets only)
    // when the fill phase changed the build; null when identical.
    // This supersedes the v1.0 cost-dominant re-run semantic.
    result.cheapest = null;
    if (fillChanged) {
      var ch = buildResult(anchorEv, null);
      result.cheapest = {
        achieved: ch.achieved, arrangement: ch.arrangement,
        setBonuses: ch.setBonuses, unmetTargets: ch.unmetTargets,
        totalRankCost: ch.totalRankCost,
        breakdown: ch.breakdown, crossGearPlan: ch.crossGearPlan,
        sustained: ch.sustained,
        hybridBurst: ch.hybridBurst,
        channel: ch.channel
      };
    }
    return result;
  }

  // ---- forward evaluator (v1.1, for the board editor) ------------------
  // evaluateFrame(data, frameName, orderedPieces) scores ONE given
  // arrangement with the solver's own forward math (contributions +
  // achievedFrom + fitCapacity — no second implementation).
  // v1.3: evaluators are intent-free by design — they score the
  // exact piece list given and never drop pieces; intent pruning
  // lives in solve() (candidate pools) and in the sustained-floor
  // filter at the buildResult call site.
  // orderedPieces = {
  //   slots: [{kind: 'aura'|'normal'|'exilus', mod, rank, polarity?}],  // board order; a polarity on any non-aura slot switches scoring to given mode (v1.5.1)
  //   arcanes: [name], shards: [{colour, tier, stat}],
  //   tome, helmet, subsume: {ability, fromFrame, replacedAbility},
  //   focus: {school, nodes?} (v1.5 — nodes omitted = full modelled set),
  //   conditional, formaBudget, umbraForma, reactor,
  //   itemKind, companionEntry, ownerStats, supportSetPieces,
  //   extraModRecords: {name: record}  // stat-less pool mods
  // } -> {achieved, capacityUsed, capacityMax, formaUsed,
  //       umbraFormaUsed, valid, warnings}
  function evaluateFrame(data, frameName, pieces) {
    pieces = pieces || {};
    var ctx = buildContext(data);
    var resolved = resolveItem(ctx, {
      itemKind: pieces.itemKind, frameName: frameName,
      companionEntry: pieces.companionEntry, ownerStats: pieces.ownerStats
    });
    var frame = resolved.frame;
    // v1.5: board parity — the evaluator tracks the frame's channel
    // exactly like solve() does, so board edits show live drain.
    ctx.channelTrack = resolved.kind === 'warframe'
      ? channelTrackFor(ctx, frame) : null;
    // v1.5 Focus parity: pieces.focus = {school, nodes?} applies the
    // school's modelled nodes exactly as solve() installed them
    // (nodes omitted = the school's full modelled set). The
    // evaluator stays intent-free: the caller passes the kept set.
    ctx.focusActive = null;
    if (resolved.kind === 'warframe' && pieces.focus &&
        typeof pieces.focus.school === 'string' && pieces.focus.school) {
      ctx.focusActive = focusActiveFor(ctx, pieces.focus.school,
        Array.isArray(pieces.focus.nodes) ? pieces.focus.nodes : null);
    }
    Object.keys(pieces.extraModRecords || {}).forEach(function (name) {
      if (!ctx.modByName[name]) {
        var rec = lockRecordNormalize(pieces.extraModRecords[name], name);
        if (rec) {
          ctx.modByName[name] = rec;
          if (rec.set) ctx.setOfMod[name] = rec.set;
        }
      }
    });
    var routes = {
      mods: true, arcanes: true, shards: true, aura: true, exilus: true,
      tome: true, conditional: !!pieces.conditional,
      legacyHelmets: true, helminth: true
    };
    var warnings = [];
    var st = emptyState(null);
    st._helmetFrame = frameName;
    // v1.5.3: the aura slot entry may carry a stamped `polarity`
    // (a Forma purchase made in the editor); pieces.omniAura is the
    // build's Omni Forma toggle. Both price the aura bonus in the
    // capacity block below — identically to fitCapacity.
    var auraEntry = null;
    (pieces.slots || []).forEach(function (s) {
      if (!s || !s.mod) return;
      if (s.kind === 'aura') { st.aura = s.mod; auraEntry = s; return; }
      var rec = ctx.modByName[s.mod];
      if (!rec) {
        warnings.push('Unknown mod "' + s.mod + '" ignored — not in the ' +
          'solver pool (pass its record via extraModRecords to include it).');
        return;
      }
      var rank = (typeof s.rank === 'number')
        ? Math.max(0, Math.min(rec.maxRank, Math.round(s.rank))) : rec.maxRank;
      if (s.kind === 'exilus') {
        if (st.exilusMod) {
          warnings.push('Two mods in the exilus slot; "' + s.mod + '" ignored.');
          return;
        }
        if (!rec.exilus) {
          warnings.push('"' + s.mod + '" is not exilus-flagged but sits in the exilus slot.');
        }
        st.exilusMod = { name: s.mod, rank: rank };
      } else {
        if (st.mods[s.mod] != null) {
          warnings.push('Duplicate mod "' + s.mod + '" counted once.');
          return;
        }
        st.mods[s.mod] = rank;
      }
    });
    st.arcanes = (pieces.arcanes || []).slice();
    if (st.arcanes.length > 2) {
      warnings.push('More than 2 arcanes listed; extras ignored.');
      st.arcanes = st.arcanes.slice(0, 2);
    }
    st.arcanes.forEach(function (n) {
      if (!ctx.arcanes.some(function (a) { return a.name === n; })) {
        warnings.push('Arcane "' + n + '" has no modelled effects; it occupies a slot only.');
      }
    });
    (pieces.shards || []).forEach(function (sh) {
      var pick = null;
      ctx.shardPicks.forEach(function (p) {
        if (p.colour === sh.colour && p.stat === sh.stat) pick = p;
      });
      if (!pick) {
        warnings.push('No shard bonus for ' + sh.colour + ' / ' + sh.stat + '; shard ignored.');
        return;
      }
      st.shards.push({
        colour: sh.colour, tier: sh.tier, stat: sh.stat, unit: pick.unit,
        value: sh.tier === 'tauforged' ? pick.tauforged : pick.normal
      });
    });
    if (pieces.tome) st.tome = pieces.tome;
    if (pieces.helmet) st.helmet = pieces.helmet;
    if (pieces.subsume) st.subsume = pieces.subsume;
    var sums = contributions(ctx, st, routes, pieces.supportSetPieces);
    var achievedRaw = achievedFrom(ctx, frame, sums);
    // v1.5.1: GIVEN-polarity mode. When any non-aura slot entry carries
    // a `polarity` property, the board's arrangement is scored as-is:
    // drain halves where the slot polarity matches the mod, and a
    // slot of a different polarity costs +25% (v1.6.0, drainInSlot;
    // a 'Universal' slot matches everything EXCEPT Umbra — v1.5.3,
    // Tacusin's ruling: only an Umbra Forma slot halves an Umbra mod;
    // the weapon evaluator has priced it this way since v1.5.2), and
    // the forma count comes from the pool formula — polarized
    // non-aura slots minus the multiset intersection of assigned vs
    // innate polarities, with the Umbra excess reported separately
    // (an Umbra match in that accounting comes only from a slot
    // whose polarity IS 'Umbra' — a 'Universal' slot never counts).
    // Without polarities the optimal pool fit runs instead, and its
    // matched plan is returned for the editor's Re-Forma tool.
    // v1.5.3: the aura slot prices through auraCapacityBonus with
    // the EFFECTIVE slot polarity — pieces.omniAura (the toggle) >
    // the aura entry's stamped polarity (an editor Forma purchase,
    // counted as 1 forma when it differs from innate) > innate.
    var anyGiven = (pieces.slots || []).some(function (s) {
      return s && s.kind !== 'aura' && ('polarity' in s);
    });
    var fit = null, plan = null;
    if (anyGiven) {
      var gSlotCount = frame._slotCount || 8;
      var polAt = {}, nameIdx = {}, assigned = {}, polarized = 0, ni = 0;
      (pieces.slots || []).forEach(function (s) {
        if (!s || s.kind === 'aura') return;
        var idx = s.kind === 'exilus' ? gSlotCount : ni++;
        var p = ('polarity' in s) ? (s.polarity || null) : null;
        polAt[idx] = p;
        if (p) { assigned[p] = (assigned[p] || 0) + 1; polarized++; }
        if (s.mod && (st.mods[s.mod] != null ||
            (st.exilusMod && st.exilusMod.name === s.mod))) nameIdx[s.mod] = idx;
      });
      var innateCounts = {};
      (frame.Polarities || []).slice(0, gSlotCount).forEach(function (p) {
        if (p) innateCounts[p] = (innateCounts[p] || 0) + 1;
      });
      var inter = 0;
      Object.keys(assigned).forEach(function (p) {
        inter += Math.min(assigned[p], innateCounts[p] || 0);
      });
      var gUmbra = Math.max(0, (assigned.Umbra || 0) - (innateCounts.Umbra || 0));
      var gUsed = 0;
      Object.keys(st.mods).concat(st.exilusMod ? [st.exilusMod.name] : [])
        .forEach(function (name) {
          var rec = ctx.modByName[name];
          var rank = st.mods[name] != null ? st.mods[name] : st.exilusMod.rank;
          var d = rec.baseDrain + rank;
          var rp = (rec.polarity && rec.polarity !== 'None') ? rec.polarity : null;
          var sp = polAt[nameIdx[name]];
          // v1.6.0 (#14): priced by the shared helper — a slot of a
          // different polarity costs +25%, not full drain.
          gUsed += drainInSlot(d, sp, rp);
        });
      // v1.5.3: aura pricing with the effective slot polarity. The
      // Omni state — pieces.omniAura (the app's toggle), or a
      // stamped polarity of 'Universal' reached by hand — is a
      // universal match, and the Omni Forma counts 1 in formaUsed
      // (Tacusin's correction: it is still a Forma), though never
      // against a budget (given mode has none). Any other stamped
      // polarity that differs from innate is a regular Forma
      // purchase and counts 1 via gAuraForma.
      var gAuraSlotPol = null, gAuraForma = 0;
      if (st.aura) {
        if (pieces.omniAura) gAuraSlotPol = 'Omni';
        else if (auraEntry && ('polarity' in auraEntry) &&
                 auraEntry.polarity != null) {
          gAuraSlotPol = auraEntry.polarity;
          if (gAuraSlotPol !== 'Universal' &&
              gAuraSlotPol !== (frame.AuraPolarity || null)) gAuraForma = 1;
        }
      }
      var gOmniForma = (st.aura &&
        (pieces.omniAura || gAuraSlotPol === 'Universal')) ? 1 : 0;
      var gAuraBonus = auraCapacityBonus(ctx, frame, st.aura,
        gAuraSlotPol === null ? undefined : gAuraSlotPol);
      var gMax = (typeof frame._baseCapacity === 'number'
        ? frame._baseCapacity : (pieces.reactor !== false ? 60 : 30)) +
        gAuraBonus;
      fit = {
        capacityUsed: gUsed, capacityMax: gMax,
        formaUsed: (polarized - inter) - gUmbra + gAuraForma + gOmniForma,
        umbraFormaUsed: gUmbra,
        valid: gUsed <= gMax,
        auraBonus: gAuraBonus,
        auraSlotPolarity: gAuraSlotPol === null
          ? (frame.AuraPolarity || null) : gAuraSlotPol,
        auraFormaUsed: gAuraForma,
        auraOmni: !!pieces.omniAura && !!st.aura
      };
    } else {
      fit = fitCapacity(ctx, frame, st,
        pieces.formaBudget != null ? pieces.formaBudget : 'any',
        pieces.reactor !== false, pieces.umbraForma || 0,
        pieces.omniAura ? { omniAura: true } : null);
      plan = fit.matched || null;
    }
    if (!fit.valid) {
      warnings.push('Capacity exceeded: ' + fit.capacityUsed +
        ' used / ' + fit.capacityMax + ' max.');
    }
    var achieved = {};
    ALL_STATS.forEach(function (k) { achieved[k] = round2(achievedRaw[k]); });
    if (ctx.channelTrack && typeof achievedRaw.channelDrain === 'number') {
      achieved.channelDrain = round2(achievedRaw.channelDrain);
    }
    // v1.2 breakdown for the board editor: chains follow the board's
    // own slot order (normal slots as listed, exilus after them).
    var evalOrdered = [], evalExilus = null;
    (pieces.slots || []).forEach(function (s) {
      if (!s || !s.mod) return;
      if (s.kind === 'exilus') evalExilus = s.mod;
      else if (s.kind !== 'aura' && st.mods[s.mod] != null) evalOrdered.push(s.mod);
    });
    var breakdown = frameBreakdown(ctx, frame, st, routes,
      pieces.supportSetPieces, evalOrdered, evalExilus, frameName);
    return {
      achieved: achieved,
      breakdown: breakdown,
      capacityUsed: fit.capacityUsed,
      capacityMax: fit.capacityMax,
      formaUsed: fit.formaUsed,
      umbraFormaUsed: fit.umbraFormaUsed || 0,
      valid: fit.valid,
      warnings: warnings,
      plan: plan,
      // v1.5.3: the aura slot's outcome, both modes (the editor's
      // derive path stamps a fit-bought purchase from these).
      auraBonus: fit.auraBonus || 0,
      auraSlotPolarity: fit.auraSlotPolarity || null,
      auraFormaUsed: fit.auraFormaUsed || 0,
      auraOmni: !!fit.auraOmni
    };
  }

  var Solver = {
    solve: solve,
    evaluateFrame: evaluateFrame,
    augmentEligible: augmentEligible, // v1.4: shared with the site
    isAugmentRecord: isAugmentRecord,
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
