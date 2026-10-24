/*
 * share_codec.js — bit-packed base62 share codes (v1.5.1 Stage C).
 *
 * The legacy share hash is base64'd JSON state (~7,000 chars for a
 * full build — too long to paste into Discord even with Nitro). This
 * codec packs the SAME v9 state into a bit stream, renders it in
 * base62, and appends a 2-char checksum: Tacusin's own 6,958-char
 * link packs to ~150 chars.
 *
 * Design commitments:
 *  - Names are NEVER written into a code. Every name resolves to an
 *    integer ID from the append-only index registry
 *    (site/data/registry.json, built by
 *    pipeline/build_index_registry.py). An ID never changes and is
 *    never reused, so a code decodes to the same build forever.
 *  - Schema: a 4-bit version field leads the payload. The encoder
 *    writes v6; decoders accept v1 through v6 and refuse
 *    anything else loudly. v2 (v1.5.2) widens two v1 layouts: board slots
 *    carry the polarity/forma bits on normal+exilus slots of WEAPON
 *    boards too (v1 wrote them for frame boards only), and weapon
 *    board extras gain a trailing optional overRankForma (u3,
 *    appended after the v1 fields so the v1 prefix is untouched).
 *    v3 (v1.5.3) adds two fields, both version-gated on decode so
 *    v1/v2 payloads parse bit-identically: the state-level omniAura
 *    toggle (1 bit, after spareShards) and polarity/forma bits on
 *    AURA slots (an aura Forma purchase; previously unrepresentable).
 *    v4 (v1.7.0) appends three frame target keys (parkourVelocity,
 *    aimGlide, sprintSpeed) to FRAME_STAT_KEYS — appended, so the
 *    v1–v3 key indices are unchanged and board-shard stat indices
 *    in old codes still read correctly; since targets are
 *    positional with no count, decoders read the 9-key list for
 *    v≤3 payloads and the 12-key list for v4.
 *    v5 (v1.8.0) appends one more key (wallLatch) as the combined
 *    Aim Glide / Wall Latch target splits into two targets in
 *    seconds. A v4 payload's combined aimGlide target is a
 *    PERCENTAGE of the unmodified value; on decode it migrates
 *    to both duration targets (same mode and priority) with the
 *    value converted through the maneuver bases — glide 3s,
 *    latch 6s, or 60s when the payload selects Loki / Loki
 *    Prime (wiki "Maneuvers" bases; Loki's latch lasts 10x
 *    longer). See migrateV4GlideTargets.
 *    v6 (v1.9.0) appends a TRAILING block after the progenitor
 *    fields (the v5 payload is a strict prefix): the formaConvert
 *    toggle (1 bit) and the Starting Pools — a count (5 bits) of
 *    per-item entries, each an item key (the attackByItem key
 *    modes) + a pool length (4 bits) + that many polarity indices
 *    (4 bits each, the POLARITIES table). Decoders gate the block
 *    on version >= 6; v≤5 payloads gain the defaults (toggle off,
 *    no declared pools — every item seeds from its innate slots).
 *  - Checksum: a digit-polynomial over the base62 body
 *    (h = (h*33 + digit) mod 3844 = 62^2), rendered as the final 2
 *    base62 chars and verified BEFORE any field is parsed — a
 *    corrupted code is an error, never a garbage build. (The demo's
 *    plain payload-mod-3844 had a blind spot: any digit at place
 *    >= 62^2 changes the value by a multiple of 3844 and is
 *    invisible to it. The polynomial form sees every single-digit
 *    change, because 33 is coprime to 3844.)
 *  - A leading sentinel 1 bit precedes the payload inside the
 *    integer, so the payload's exact bit length survives the trip
 *    through BigInt (leading zero bits of the version field would
 *    otherwise vanish).
 *  - Canonical form: fields at their defaults cost only their flag /
 *    mode bits (dontcare targets, empty wallet colours, absent board,
 *    ...). The decoder re-expands everything to a full v13 state
 *    (older payloads gain the later defaults: omniAura false,
 *    movement targets dontcare; v4 payloads gain the migrated
 *    glide/latch pair; v≤5 payloads gain formaConvert false and no
 *    declared Starting Pools).
 *  - encode() returns null (never throws, never guesses) when a state
 *    carries something the schema cannot name — the app then falls
 *    back to the legacy long link. Documented refusals: names absent
 *    from the registry, counts past their field caps (locks > 15 per
 *    category, attackByItem > 15 entries, abilityLocks > 31 frames,
 *    wallet counts > 1023, board > 31 slots, focus nodes > 31,
 *    Starting Pools > 31 items or > 15 entries in one pool),
 *    unknown board-extras keys (extras pass through the app's state
 *    merge untouched, so an unmodelled key is real user data), and
 *    values outside the enumerated domains (forma budget, itemKind,
 *    a Starting Pool entry that is not one of the eight polarities).
 *  - One derived field: board extras' companionEntry (the assembled
 *    MOA/Hound entry) is a pure function of state.parts + the shipped
 *    modular data, both of which travel in the code / the site
 *    bundle. The codec writes only its presence bit; decode emits
 *    { fromParts: true } and the app re-assembles the entry exactly
 *    as it does everywhere else (currentCompanion()).
 *
 * Pure module: ShareCodec.create(registry) -> {encode, decode,
 * isCode}. No DOM, no solver — safe to load anywhere.
 */
(function () {
  'use strict';

  var B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var SCHEMA_VERSION = 6;

  // Fixed enums (mirror site/js/app.js — the category order is the
  // app's CATEGORIES order; stat lists are the app's target stores).
  var CATEGORIES = ['Warframe', 'Primary', 'Secondary', 'Melee',
    'Archgun', 'Archmelee', 'Companion', 'Companion Weapon',
    'Necramech', 'Kitgun', 'Zaw', 'Amp'];
  var SELECTION_KEYS = ['Warframe', 'Necramech', 'Companion', 'Primary',
    'Secondary', 'Melee', 'Archgun', 'Archmelee', 'Companion Weapon'];
  var SELECTION_NS = {
    'Warframe': 'frames', 'Necramech': 'necramechs',
    'Companion': 'companions', 'Primary': 'weapon:Primary',
    'Secondary': 'weapon:Secondary', 'Melee': 'weapon:Melee',
    'Archgun': 'weapon:Archgun', 'Archmelee': 'weapon:Archmelee',
    'Companion Weapon': 'weapon:Companion Weapon'
  };
  var PART_SLOTS = [
    ['kitgun', 'grip', 'part:kitgun:grip'],
    ['kitgun', 'chamber', 'part:kitgun:chamber'],
    ['kitgun', 'loader', 'part:kitgun:loader'],
    ['zaw', 'strike', 'part:zaw:strike'],
    ['zaw', 'grip', 'part:zaw:grip'],
    ['zaw', 'link', 'part:zaw:link'],
    ['amp', 'prism', 'part:amp:prism'],
    ['amp', 'scaffold', 'part:amp:scaffold'],
    ['amp', 'brace', 'part:amp:brace'],
    ['moa', 'model', 'part:moa:model'],
    ['moa', 'core', 'part:moa:core'],
    ['moa', 'gyro', 'part:moa:gyro'],
    ['moa', 'bracket', 'part:moa:bracket'],
    ['hound', 'model', 'part:hound:model'],
    ['hound', 'core', 'part:hound:core'],
    ['hound', 'bracket', 'part:hound:bracket'],
    ['hound', 'stabilizer', 'part:hound:stabilizer']
  ];
  var FRAME_STAT_KEYS = ['abilityStrength', 'abilityDuration',
    'abilityRange', 'abilityEfficiency', 'health', 'shield', 'armor',
    'energyMax', 'channelDrain',
    // v4 (v1.7.0): movement target keys, APPENDED — the indices of
    // the v1–v3 keys are unchanged, so board-shard stat indices in
    // old codes still read correctly. Targets are positional with
    // no count, so decoders gate the list on the code's version:
    // v≤3 payloads carry only the first 9 keys.
    'parkourVelocity', 'aimGlide', 'sprintSpeed',
    // v5 (v1.8.0): wallLatch appended as the combined glide/latch
    // target splits in two; v4 payloads carry the first 12 keys
    // and migrate (see the header note).
    'wallLatch'];
  var FRAME_STAT_KEYS_V3 = FRAME_STAT_KEYS.slice(0, 9);
  var FRAME_STAT_KEYS_V4 = FRAME_STAT_KEYS.slice(0, 12);
  var WEAPON_STAT_KEYS = ['totalDamagePerShot', 'critChance',
    'critMultiplier', 'statusChance', 'fireRate', 'multishot',
    'magazine', 'reload', 'punchThrough'];
  var DMG_STAT_KEYS = ['Impact', 'Puncture', 'Slash', 'Heat', 'Cold',
    'Electric', 'Toxin', 'Blast', 'Corrosive', 'Gas', 'Magnetic',
    'Radiation', 'Viral', 'Void'].map(function (t) { return 'dmg:' + t; });
  var AMP_STAT_KEYS = ['damage', 'critChance', 'critMultiplier',
    'statusChance', 'fireRate', 'multishot'];
  var MODES = ['dontcare', 'atleast', 'closest', 'maximize'];
  var POLARITIES = [null, 'Madurai', 'Naramon', 'Vazarin', 'Zenurik',
    'Penjaga', 'Unairu', 'Umbra', 'Universal'];
  var SLOT_KINDS = ['aura', 'stance', 'normal', 'exilus'];
  var COLOURS = ['Crimson', 'Amber', 'Azure', 'Emerald', 'Topaz', 'Violet'];
  var PROGENITOR_ELEMENTS = ['Heat', 'Cold', 'Electric', 'Toxin',
    'Impact', 'Magnetic', 'Radiation'];
  var ROUTES_FRAME_KEYS = ['mods', 'arcanes', 'shards', 'aura', 'exilus',
    'legacyHelmets', 'tome', 'conditional', 'augments', 'helminth'];
  var ROUTES_WEAPON_KEYS = ['mods', 'arcanes', 'exilus', 'stance',
    'conditional'];
  var NUMCHARS = '0123456789.-+eE ';
  var FRAME_EXTRAS_KEYS = ['arcanes', 'shards', 'tome', 'helmet',
    'subsume', 'focus', 'conditional', 'formaBudget', 'umbraForma',
    'itemKind', 'companionEntry', 'ownerStats', 'supportSetPieces'];
  var WEAPON_EXTRAS_KEYS = ['arcane', 'conditional', 'formaBudget',
    'umbraForma', 'stance', 'progenitor', 'attackIndex', 'weaponName',
    'overRankForma'];

  function CodecError(msg) { var e = new Error(msg); e.codec = true; return e; }

  // ---- UTF-8 (manual: no TextDecoder dependency) -------------------
  function utf8Encode(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                   0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return bytes;
  }
  function utf8Decode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xE0) out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
      else if (b < 0xF0) out += String.fromCharCode(((b & 0x0F) << 12) |
        ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
      else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
                 ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function create(registry) {
    if (!registry || !registry.namespaces) {
      throw new Error('ShareCodec.create: registry with namespaces required');
    }
    var NS = {};   // ns -> {names, index: Map(name->id), width}
    Object.keys(registry.namespaces).forEach(function (ns) {
      var names = registry.namespaces[ns].names || [];
      var index = new Map();
      names.forEach(function (n, i) { if (!index.has(n)) index.set(n, i); });
      var width = Math.max(1, Math.ceil(Math.log2(Math.max(2, names.length))));
      NS[ns] = { names: names, index: index, width: width };
    });
    function nsEntry(ns) {
      var e = NS[ns];
      if (!e) throw CodecError('registry namespace missing: ' + ns);
      return e;
    }
    function idOf(ns, name) {
      var e = nsEntry(ns);
      var id = e.index.get(name);
      if (id === undefined) throw CodecError('name not in registry ' + ns + ': ' + name);
      return id;
    }
    function nameOf(ns, id) {
      var e = nsEntry(ns);
      if (id >= e.names.length) throw CodecError('id out of range in ' + ns + ': ' + id);
      return e.names[id];
    }
    function widthOf(ns) { return nsEntry(ns).width; }

    // ---- bit writer / reader ---------------------------------------
    function Writer() { this.acc = 1n; this.bits = 0; }
    Writer.prototype.w = function (val, n) {
      if (!Number.isInteger(val) || val < 0 || val >= Math.pow(2, n)) {
        throw CodecError('field out of range: ' + val + ' in ' + n + ' bits');
      }
      this.acc = (this.acc << BigInt(n)) | BigInt(val);
      this.bits += n;
    };
    Writer.prototype.wBool = function (b) { this.w(b ? 1 : 0, 1); };
    Writer.prototype.wIndex = function (ns, name) {
      this.w(idOf(ns, name), widthOf(ns));
    };
    Writer.prototype.wRawString = function (str) {
      var bytes = utf8Encode(str);
      if (bytes.length > 255) throw CodecError('raw string too long (' + bytes.length + 'b)');
      this.w(bytes.length, 8);
      for (var i = 0; i < bytes.length; i++) this.w(bytes[i], 8);
    };
    // Numeric-string field (target values, priorities, percents):
    // 4-bit char count over a 16-char numeric alphabet; count 15 is
    // the escape to a raw byte string for anything exotic.
    Writer.prototype.wNumStr = function (str) {
      str = str == null ? '' : String(str);
      var ok = str.length <= 14;
      if (ok) for (var i = 0; i < str.length; i++) {
        if (NUMCHARS.indexOf(str.charAt(i)) < 0) { ok = false; break; }
      }
      if (ok) {
        this.w(str.length, 4);
        for (var j = 0; j < str.length; j++) this.w(NUMCHARS.indexOf(str.charAt(j)), 4);
      } else {
        this.w(15, 4);
        this.wRawString(str);
      }
    };
    // String field with modes: 0 = derive (only when a derive fn is
    // supplied and reproduces the value), 1 = registry index,
    // 2 = raw string.
    Writer.prototype.wStrField = function (value, ns, deriveFn) {
      if (deriveFn && deriveFn() === value) { this.w(0, 2); return; }
      if (ns && typeof value === 'string' && nsEntry(ns).index.has(value)) {
        this.w(1, 2); this.wIndex(ns, value); return;
      }
      if (typeof value === 'string') { this.w(2, 2); this.wRawString(value); return; }
      throw CodecError('string field cannot encode: ' + value);
    };

    function Reader(bitStr) { this.s = bitStr; this.pos = 0; }
    Reader.prototype.r = function (n) {
      if (this.pos + n > this.s.length) throw CodecError('share code is malformed (truncated)');
      var v = 0;
      for (var i = 0; i < n; i++) v = v * 2 + (this.s.charCodeAt(this.pos++) - 48);
      return v;
    };
    Reader.prototype.rBool = function () { return this.r(1) === 1; };
    Reader.prototype.rIndex = function (ns) { return nameOf(ns, this.r(widthOf(ns))); };
    Reader.prototype.rRawString = function () {
      var len = this.r(8), bytes = [];
      for (var i = 0; i < len; i++) bytes.push(this.r(8));
      return utf8Decode(bytes);
    };
    Reader.prototype.rNumStr = function () {
      var len = this.r(4);
      if (len === 15) return this.rRawString();
      var out = '';
      for (var i = 0; i < len; i++) out += NUMCHARS.charAt(this.r(4));
      return out;
    };
    Reader.prototype.rStrField = function (ns, deriveFn) {
      var mode = this.r(2);
      if (mode === 0) {
        if (!deriveFn) throw CodecError('share code is malformed (derive mode without context)');
        return deriveFn();
      }
      if (mode === 1) return this.rIndex(ns);
      if (mode === 2) return this.rRawString();
      throw CodecError('share code is malformed (string mode 3)');
    };
    Reader.prototype.remaining = function () { return this.s.length - this.pos; };

    // ---- shared helpers ---------------------------------------------
    function catKind(catId) {
      var i = CATEGORIES.indexOf(catId);
      if (i < 0) return null;
      return ['frame', 'weapon', 'weapon', 'weapon', 'weapon', 'weapon',
        'companion', 'weapon', 'necramech', 'kitgun', 'zaw', 'amp'][i];
    }
    function itemNsFor(catId) {
      return SELECTION_NS[catId] || null;
    }
    // Mirror of app.js currentItemKey(), keyed by an explicit
    // category (the board's own catId) instead of the live one.
    function deriveItemKey(catId, selections, parts) {
      var kind = catKind(catId);
      if (kind === 'kitgun') {
        var p = parts.kitgun;
        return 'kitgun:' + p.chamber + '/' + p.grip + '/' + p.loader;
      }
      if (kind === 'zaw') {
        var q = parts.zaw;
        return 'zaw:' + q.strike + '/' + q.grip + '/' + q.link;
      }
      if (kind === 'amp') {
        var a = parts.amp;
        return 'amp:' + a.prism + '/' + a.scaffold + '/' + a.brace;
      }
      return selections[catId] || catId;
    }
    function wForma(w, v) {
      if (v === 'any') { w.w(31, 5); return; }
      if (Number.isInteger(v) && v >= 0 && v <= 10) { w.w(v, 5); return; }
      throw CodecError('forma value outside the schema domain: ' + v);
    }
    function rForma(r) {
      var v = r.r(5);
      return v === 31 ? 'any' : v;
    }
    function wCount(w, n, bits, what) {
      if (!Number.isInteger(n) || n < 0 || n >= Math.pow(2, bits)) {
        throw CodecError(what + ' count past the schema cap: ' + n);
      }
      w.w(n, bits);
    }
    function wTargets(w, store, keys) {
      keys.forEach(function (k) {
        var t = store ? store[k] : null;
        var mode = t ? MODES.indexOf(t.mode) : 0;
        if (mode < 0) mode = 0;
        w.w(mode, 2);
        if (mode > 0) {
          w.wNumStr(t.value == null ? '' : String(t.value));
          w.wNumStr(t.priority == null ? '' : String(t.priority));
        }
      });
    }
    function rTargets(r, keys) {
      var out = {};
      keys.forEach(function (k) {
        var mode = r.r(2);
        if (mode === 0) out[k] = { mode: 'dontcare', value: '', priority: '' };
        else out[k] = { mode: MODES[mode], value: r.rNumStr(), priority: r.rNumStr() };
      });
      return out;
    }
    // v5 migration (v1.8.0): a v4 payload's combined aimGlide
    // target is a percentage of the unmodified value (100 =
    // unmodified). It becomes BOTH duration targets — same mode
    // and priority — with numeric values converted through the
    // maneuver bases (wiki "Maneuvers": Aim Glide 3s; Wall
    // Latch 6s, or 60s when the payload's Warframe selection is
    // Loki / Loki Prime, whose latch lasts 10x longer). A
    // non-numeric value (mode set, value blank) is copied
    // verbatim to both targets instead of converted.
    function migrateV4GlideTargets(st) {
      var t = st.frameTargets.aimGlide;
      if (!t || !t.mode || t.mode === 'dontcare') {
        st.frameTargets.wallLatch =
          { mode: 'dontcare', value: '', priority: '' };
        return;
      }
      var sel = st.selections ? st.selections.Warframe : null;
      var latchBase = (sel === 'Loki' || sel === 'Loki Prime') ? 60 : 6;
      var pct = parseFloat(t.value);
      if (isFinite(pct)) {
        var conv = function (b) {
          return String(Math.round(b * pct / 100 * 10000) / 10000);
        };
        st.frameTargets.aimGlide =
          { mode: t.mode, value: conv(3), priority: t.priority };
        st.frameTargets.wallLatch =
          { mode: t.mode, value: conv(latchBase), priority: t.priority };
      } else {
        st.frameTargets.wallLatch =
          { mode: t.mode, value: t.value, priority: t.priority };
      }
    }
    function wPieces(w, entry, withRanks) {
      var mods = (entry && entry.mods) || [];
      var arcanes = (entry && entry.arcanes) || [];
      var present = mods.length > 0 || arcanes.length > 0;
      w.wBool(present);
      if (!present) return;
      wCount(w, mods.length, 4, 'locks/excludes mods');
      mods.forEach(function (m) {
        w.wIndex('mods', m.name);
        if (withRanks) {
          var rank = parseInt(m.rank, 10);
          if (!Number.isInteger(rank) || rank < 0 || rank > 15) {
            throw CodecError('lock rank outside the schema domain: ' + m.rank);
          }
          w.w(rank, 4);
        }
      });
      wCount(w, arcanes.length, 3, 'locks/excludes arcanes');
      arcanes.forEach(function (n) { w.wIndex('arcanes', n); });
    }
    function rPieces(r, withRanks) {
      if (!r.rBool()) return null;
      var mods = [], arcanes = [], i, n = r.r(4);
      for (i = 0; i < n; i++) {
        var name = r.rIndex('mods');
        if (withRanks) mods.push({ name: name, rank: r.r(4) });
        else mods.push(name);
      }
      n = r.r(3);
      for (i = 0; i < n; i++) arcanes.push(r.rIndex('arcanes'));
      return { mods: mods, arcanes: arcanes };
    }

    // ---- board -------------------------------------------------------
    function checkExtrasKeys(extras, known) {
      Object.keys(extras).forEach(function (k) {
        if (known.indexOf(k) < 0) {
          throw CodecError('board extras key outside the schema: ' + k);
        }
      });
    }
    function wFrameExtras(w, x) {
      checkExtrasKeys(x, FRAME_EXTRAS_KEYS);
      var arcanes = x.arcanes || [];
      wCount(w, arcanes.length, 3, 'board arcanes');
      arcanes.forEach(function (n) { w.wIndex('arcanes', n); });
      var shards = x.shards || [];
      wCount(w, shards.length, 3, 'board shards');
      shards.forEach(function (s) {
        var ci = COLOURS.indexOf(s.colour);
        if (ci < 0) throw CodecError('shard colour outside the schema: ' + s.colour);
        w.w(ci, 3);
        w.wBool(s.tier === 'tauforged');
        var si = FRAME_STAT_KEYS.indexOf(s.stat);
        if (si < 0) throw CodecError('shard stat outside the schema: ' + s.stat);
        w.w(si, 4);
      });
      w.wBool(x.tome != null);
      if (x.tome != null) w.wIndex('mods', x.tome);
      w.wBool(x.helmet != null);
      if (x.helmet != null) w.wIndex('helmets', x.helmet);
      w.wBool(x.subsume != null);
      if (x.subsume != null) {
        w.wIndex('helminthDonors', x.subsume.ability);
        w.wIndex('frames', x.subsume.fromFrame);
        w.wIndex('abilities', x.subsume.replacedAbility);
      }
      w.wBool(x.focus != null);
      if (x.focus != null) {
        w.wIndex('focusSchools', x.focus.school);
        var nodes = x.focus.nodes || [];
        wCount(w, nodes.length, 5, 'focus nodes');
        nodes.forEach(function (n) { w.wIndex('focusNodes', n); });
      }
      w.wBool(!!x.conditional);
      wForma(w, x.formaBudget === undefined ? 'any' : x.formaBudget);
      var uf = x.umbraForma == null ? 0 : x.umbraForma;
      if (!Number.isInteger(uf) || uf < 0 || uf > 31) {
        throw CodecError('board umbraForma outside the schema domain: ' + uf);
      }
      w.w(uf, 5);
      var ik = x.itemKind == null ? 0 :
        ({ warframe: 1, necramech: 2, companion: 3 })[x.itemKind];
      if (ik === undefined) throw CodecError('itemKind outside the schema: ' + x.itemKind);
      w.w(ik, 2);
      w.wBool(x.companionEntry != null);
      w.wBool(x.ownerStats != null);
      if (x.ownerStats != null) {
        w.wNumStr(x.ownerStats.health);
        w.wNumStr(x.ownerStats.shield);
        w.wNumStr(x.ownerStats.armor);
      }
      w.wBool(x.supportSetPieces != null);
      if (x.supportSetPieces != null) {
        var sets = Object.keys(x.supportSetPieces);
        wCount(w, sets.length, 3, 'support set pieces');
        sets.forEach(function (s) {
          w.wIndex('sets', s);
          var c = x.supportSetPieces[s];
          if (!Number.isInteger(c) || c < 0 || c > 15) {
            throw CodecError('set piece count outside the schema domain: ' + c);
          }
          w.w(c, 4);
        });
      }
    }
    function rFrameExtras(r) {
      var x = {}, i, n = r.r(3);
      x.arcanes = [];
      for (i = 0; i < n; i++) x.arcanes.push(r.rIndex('arcanes'));
      n = r.r(3);
      x.shards = [];
      for (i = 0; i < n; i++) {
        var colour = COLOURS[r.r(3)];
        var tier = r.rBool() ? 'tauforged' : 'normal';
        var stat = FRAME_STAT_KEYS[r.r(4)];
        x.shards.push({ colour: colour, tier: tier, stat: stat });
      }
      x.tome = r.rBool() ? r.rIndex('mods') : null;
      x.helmet = r.rBool() ? r.rIndex('helmets') : null;
      x.subsume = r.rBool() ? {
        ability: r.rIndex('helminthDonors'),
        fromFrame: r.rIndex('frames'),
        replacedAbility: r.rIndex('abilities')
      } : null;
      if (r.rBool()) {
        var school = r.rIndex('focusSchools');
        var nn = r.r(5), nodes = [];
        for (i = 0; i < nn; i++) nodes.push(r.rIndex('focusNodes'));
        x.focus = { school: school, nodes: nodes };
      } else x.focus = null;
      x.conditional = r.rBool();
      x.formaBudget = rForma(r);
      x.umbraForma = r.r(5);
      var ik = r.r(2);
      x.itemKind = ik === 0 ? null : ['warframe', 'necramech', 'companion'][ik - 1];
      x.companionEntry = r.rBool() ? { fromParts: true } : null;
      if (r.rBool()) {
        x.ownerStats = { health: r.rNumStr(), shield: r.rNumStr(), armor: r.rNumStr() };
      } else x.ownerStats = null;
      if (r.rBool()) {
        var sc = r.r(3);
        x.supportSetPieces = {};
        for (i = 0; i < sc; i++) x.supportSetPieces[r.rIndex('sets')] = r.r(4);
      } else x.supportSetPieces = null;
      return x;
    }
    function wWeaponExtras(w, x, catId, selections, parts) {
      checkExtrasKeys(x, WEAPON_EXTRAS_KEYS);
      w.wBool(x.arcane != null);
      if (x.arcane != null) w.wIndex('arcanes', x.arcane);
      w.wBool(!!x.conditional);
      wForma(w, x.formaBudget === undefined ? 'any' : x.formaBudget);
      var uf = x.umbraForma == null ? 0 : x.umbraForma;
      if (!Number.isInteger(uf) || uf < 0 || uf > 31) {
        throw CodecError('board umbraForma outside the schema domain: ' + uf);
      }
      w.w(uf, 5);
      w.wBool(x.stance !== false);
      w.wBool(x.progenitor != null);
      if (x.progenitor != null) {
        var ei = PROGENITOR_ELEMENTS.indexOf(x.progenitor.element);
        if (ei < 0) throw CodecError('progenitor element outside the schema: ' +
          x.progenitor.element);
        w.w(ei, 3);
        w.wNumStr(x.progenitor.percent);
      }
      var ai = x.attackIndex == null ? 0 : x.attackIndex;
      if (!Number.isInteger(ai) || ai < 0 || ai > 15) {
        throw CodecError('attackIndex outside the schema domain: ' + ai);
      }
      w.w(ai, 4);
      var wn = x.weaponName === undefined ? null : x.weaponName;
      w.wBool(wn != null);
      if (wn != null) {
        w.wStrField(wn, itemNsFor(catId), function () {
          var kind = catKind(catId);
          if (kind !== 'weapon' && kind !== 'companion') return {};
          return selections[catId] || null;
        });
      }
      // v2: trailing over-rank level (absent on pre-v1.5.2 boards).
      var orf = x.overRankForma == null ? null : x.overRankForma;
      w.wBool(orf != null);
      if (orf != null) {
        if (!Number.isInteger(orf) || orf < 0 || orf > 5) {
          throw CodecError('board overRankForma outside the schema domain: ' + orf);
        }
        w.w(orf, 3);
      }
    }
    function rWeaponExtras(r, catId, selections, parts, version) {
      var x = {};
      x.arcane = r.rBool() ? r.rIndex('arcanes') : null;
      x.conditional = r.rBool();
      x.formaBudget = rForma(r);
      x.umbraForma = r.r(5);
      x.stance = r.rBool();
      if (r.rBool()) {
        x.progenitor = {
          element: PROGENITOR_ELEMENTS[r.r(3)],
          percent: parseFloat(r.rNumStr())
        };
      } else x.progenitor = null;
      x.attackIndex = r.r(4);
      x.weaponName = r.rBool() ? r.rStrField(itemNsFor(catId), function () {
        var kind = catKind(catId);
        if (kind !== 'weapon' && kind !== 'companion') return null;
        return selections[catId] || null;
      }) : null;
      if (version >= 2) {
        x.overRankForma = r.rBool() ? r.r(3) : null;
      }
      return x;
    }
    function wBoard(w, board, selections, parts) {
      w.wBool(board != null && typeof board === 'object');
      if (board == null || typeof board !== 'object') return;
      if (board.kind !== 'frame' && board.kind !== 'weapon') {
        throw CodecError('board kind outside the schema: ' + board.kind);
      }
      w.wBool(board.kind === 'weapon');
      var ci = CATEGORIES.indexOf(board.catId);
      if (ci < 0) throw CodecError('board catId outside the schema: ' + board.catId);
      w.w(ci, 4);
      var catId = board.catId;
      w.wStrField(board.itemKey, itemNsFor(catId), function () {
        return deriveItemKey(catId, selections, parts);
      });
      var slots = board.slots || [];
      wCount(w, slots.length, 5, 'board slots');
      slots.forEach(function (s) {
        var ki = SLOT_KINDS.indexOf(s.kind);
        if (ki < 0) throw CodecError('slot kind outside the schema: ' + s.kind);
        w.w(ki, 2);
        w.wBool(s.mod != null);
        if (s.mod != null) {
          w.wIndex(s.kind === 'aura' ? 'auras' : 'mods', s.mod);
          w.wBool(s.rank != null);
          if (s.rank != null) {
            if (!Number.isInteger(s.rank) || s.rank < 0 || s.rank > 15) {
              throw CodecError('slot rank outside the schema domain: ' + s.rank);
            }
            w.w(s.rank, 4);
          }
        }
        // v1: frame boards only. v2: weapon boards too (v1.5.2).
        // v3: aura slots carry the bits too (v1.5.3) — an aura
        // Forma purchase is board state like any other.
        if (s.kind === 'normal' || s.kind === 'exilus' || s.kind === 'aura') {
          var hasPol = Object.prototype.hasOwnProperty.call(s, 'pol');
          w.wBool(hasPol);
          if (hasPol) {
            var pi = POLARITIES.indexOf(s.pol === undefined ? null : s.pol);
            if (pi < 0) throw CodecError('slot polarity outside the schema: ' + s.pol);
            w.w(pi, 4);
          }
          w.wBool(!!s.f);
          w.wBool(!!s.uf);
        }
      });
      var extras = board.extras || {};
      if (board.kind === 'frame') wFrameExtras(w, extras);
      else wWeaponExtras(w, extras, catId, selections, parts);
    }
    function rBoard(r, selections, parts, version) {
      if (!r.rBool()) return null;
      var kind = r.rBool() ? 'weapon' : 'frame';
      var catId = CATEGORIES[r.r(4)];
      var itemKey = r.rStrField(itemNsFor(catId), function () {
        return deriveItemKey(catId, selections, parts);
      });
      var n = r.r(5), slots = [];
      for (var i = 0; i < n; i++) {
        var sk = SLOT_KINDS[r.r(2)];
        var slot = { kind: sk, mod: null, rank: null };
        if (r.rBool()) {
          slot.mod = r.rIndex(sk === 'aura' ? 'auras' : 'mods');
          slot.rank = r.rBool() ? r.r(4) : null;
        }
        // v1 codes carry these bits on frame boards only; v2 on both.
        // v3 adds them on aura slots (v1/v2 aura slots have none).
        if (((version >= 2 || kind === 'frame') &&
             (sk === 'normal' || sk === 'exilus')) ||
            (version >= 3 && sk === 'aura')) {
          if (r.rBool()) slot.pol = POLARITIES[r.r(4)];
          if (r.rBool()) slot.f = true;
          if (r.rBool()) slot.uf = true;
        }
        slots.push(slot);
      }
      var extras = kind === 'frame' ? rFrameExtras(r) :
        rWeaponExtras(r, catId, selections, parts, version);
      return { kind: kind, catId: catId, itemKey: itemKey, slots: slots, extras: extras };
    }

    // ---- whole-state encode / decode ---------------------------------
    function encodeState(state) {
      var w = new Writer();
      w.w(SCHEMA_VERSION, 4);
      var ci = CATEGORIES.indexOf(state.category);
      if (ci < 0) throw CodecError('category outside the schema: ' + state.category);
      w.w(ci, 4);
      w.w(state.intent === 'upkeep' ? 1 : state.intent === 'hybrid' ? 2 : 0, 2);
      w.wBool(state.hybridAllowance === 2);
      w.wBool(state.channelPreference === 'duration');
      w.wBool(!!state.spareShards);
      w.wBool(!!state.omniAura); // v3 (v1.5.3): Omni Forma aura toggle
      // selections
      var selections = state.selections || {};
      SELECTION_KEYS.forEach(function (k) {
        var v = selections[k];
        if (v == null || typeof v !== 'string') { w.w(0, 2); return; }
        var ns = SELECTION_NS[k];
        if (nsEntry(ns).index.has(v)) { w.w(1, 2); w.wIndex(ns, v); }
        else { w.w(2, 2); w.wRawString(v); }
      });
      // parts (all 17 slots; mergeState-complete states always carry them)
      var parts = state.parts || {};
      PART_SLOTS.forEach(function (ps) {
        var fam = parts[ps[0]] || {};
        var v = fam[ps[1]];
        if (typeof v !== 'string') {
          throw CodecError('part value missing for ' + ps[0] + '.' + ps[1]);
        }
        w.wIndex(ps[2], v);
      });
      // attackByItem
      var attacks = state.attackByItem || {};
      var akeys = Object.keys(attacks);
      wCount(w, akeys.length, 4, 'attackByItem entries');
      akeys.forEach(function (key) {
        var val = attacks[key];
        if (!Number.isInteger(val) || val < 0 || val > 31) {
          throw CodecError('attack index outside the schema domain: ' + val);
        }
        var done = false;
        var fixed = [['frames', 1], ['necramechs', 2], ['companions', 3]];
        for (var i = 0; i < fixed.length && !done; i++) {
          if (nsEntry(fixed[i][0]).index.has(key)) {
            w.w(fixed[i][1], 3); w.wIndex(fixed[i][0], key); done = true;
          }
        }
        if (!done) {
          var wns = ['weapon:Primary', 'weapon:Secondary', 'weapon:Melee',
            'weapon:Archgun', 'weapon:Archmelee', 'weapon:Companion Weapon'];
          for (var j = 0; j < wns.length && !done; j++) {
            if (nsEntry(wns[j]).index.has(key)) {
              w.w(4, 3); w.w(j, 3); w.wIndex(wns[j], key); done = true;
            }
          }
        }
        if (!done) { w.w(0, 3); w.wRawString(key); }
        w.w(val, 5);
      });
      // targets
      wTargets(w, state.frameTargets, FRAME_STAT_KEYS);
      wTargets(w, state.weaponTargets, WEAPON_STAT_KEYS);
      wTargets(w, state.dmgTargets, DMG_STAT_KEYS);
      wTargets(w, state.ampTargets, AMP_STAT_KEYS);
      // locks + excludes, per category
      var locks = state.locks || {};
      CATEGORIES.forEach(function (c) { wPieces(w, locks[c], true); });
      var excludes = state.excludes || {};
      CATEGORIES.forEach(function (c) {
        var e = excludes[c];
        if (!e) { w.wBool(false); return; }
        wPieces(w, { mods: (e.mods || []).map(function (n) { return { name: n }; }),
                     arcanes: e.arcanes || [] }, false);
      });
      // helminth
      w.wBool(state.helminthMode === 'choose');
      var hc = state.helminthChoice || {};
      w.wBool(typeof hc.donor === 'string' && hc.donor !== '');
      if (typeof hc.donor === 'string' && hc.donor !== '') {
        w.wIndex('helminthDonors', hc.donor);
        var ri = parseInt(hc.replacesIndex, 10);
        w.w(Number.isInteger(ri) && ri >= 0 && ri <= 3 ? ri : 0, 2);
      }
      // focus school
      w.wBool(typeof state.focusSchool === 'string' && state.focusSchool !== '');
      if (typeof state.focusSchool === 'string' && state.focusSchool !== '') {
        w.wIndex('focusSchools', state.focusSchool);
      }
      // cross-gear
      var cg = state.crossGear || {};
      w.wBool(!!cg.on);
      var inc = cg.include || [];
      wCount(w, inc.length, 4, 'cross-gear include');
      inc.forEach(function (e2) { w.wIndex('mods', e2.mod); });
      var exc = cg.exclude || [];
      wCount(w, exc.length, 4, 'cross-gear exclude');
      exc.forEach(function (name) {
        if (nsEntry('sets').index.has(name)) { w.wBool(true); w.wIndex('sets', name); }
        else if (nsEntry('mods').index.has(name)) { w.wBool(false); w.wIndex('mods', name); }
        else throw CodecError('cross-gear exclude name unknown: ' + name);
      });
      // board
      wBoard(w, state.board, selections, parts);
      // routes
      var rf = state.routesFrame || {};
      ROUTES_FRAME_KEYS.forEach(function (k) { w.wBool(!!rf[k]); });
      var rw = state.routesWeapon || {};
      ROUTES_WEAPON_KEYS.forEach(function (k) { w.wBool(!!rw[k]); });
      w.wBool(state.ampConditional !== false);
      // ability locks
      var al = state.abilityLocks || {};
      var alFrames = Object.keys(al).filter(function (f) { return Array.isArray(al[f]); });
      wCount(w, alFrames.length, 5, 'abilityLocks frames');
      alFrames.forEach(function (f) {
        w.wIndex('frames', f);
        var arr = al[f];
        if (arr.length > 7) throw CodecError('ability lock array past the schema cap');
        w.w(arr.length, 3);
        for (var i = 0; i < arr.length; i++) w.wBool(!!arr[i]);
      });
      // wallet
      var wallet = state.wallet || {};
      COLOURS.forEach(function (c) {
        var cw = wallet[c];
        var present = !!cw && (!!cw.normal || !!cw.tauforged || !!cw.canFuseAscent);
        w.wBool(present);
        if (present) {
          if (!Number.isInteger(cw.normal) || cw.normal < 0 || cw.normal > 1023 ||
              !Number.isInteger(cw.tauforged) || cw.tauforged < 0 || cw.tauforged > 1023) {
            throw CodecError('wallet count outside the schema domain for ' + c);
          }
          w.w(cw.normal, 10);
          w.w(cw.tauforged, 10);
          w.wBool(!!cw.canFuseAscent);
        }
      });
      w.wBool(!!state.canFuseCoalescent);
      wForma(w, state.forma === undefined ? 'any' : state.forma);
      var uf2 = state.umbraForma == null ? 0 : state.umbraForma;
      if (!Number.isInteger(uf2) || uf2 < 0 || uf2 > 31) {
        throw CodecError('umbraForma outside the schema domain: ' + uf2);
      }
      w.w(uf2, 5);
      var os = state.ownerStats || {};
      w.wNumStr(os.health);
      w.wNumStr(os.shield);
      w.wNumStr(os.armor);
      var pg = state.progenitor || {};
      var pei = PROGENITOR_ELEMENTS.indexOf(pg.element === undefined ? 'Heat' : pg.element);
      if (pei < 0) throw CodecError('progenitor element outside the schema: ' + pg.element);
      w.w(pei, 3);
      w.wNumStr(pg.percent === undefined ? 60 : pg.percent);
      // v6 (v1.9.0): the trailing block — conversion toggle, then
      // the Starting Pools. Item keys use the attackByItem modes;
      // pool entries are POLARITIES indices (1..8 — a pool entry
      // is always a real polarity, never null).
      w.wBool(!!state.formaConvert);
      var pools = state.startingPools || {};
      var pkeys = Object.keys(pools).filter(function (k) {
        return Array.isArray(pools[k]);
      });
      wCount(w, pkeys.length, 5, 'Starting Pool items');
      pkeys.forEach(function (key) {
        var done = false;
        var fixed = [['frames', 1], ['necramechs', 2], ['companions', 3]];
        for (var i = 0; i < fixed.length && !done; i++) {
          if (nsEntry(fixed[i][0]).index.has(key)) {
            w.w(fixed[i][1], 3); w.wIndex(fixed[i][0], key); done = true;
          }
        }
        if (!done) {
          var wns = ['weapon:Primary', 'weapon:Secondary', 'weapon:Melee',
            'weapon:Archgun', 'weapon:Archmelee', 'weapon:Companion Weapon'];
          for (var j = 0; j < wns.length && !done; j++) {
            if (nsEntry(wns[j]).index.has(key)) {
              w.w(4, 3); w.w(j, 3); w.wIndex(wns[j], key); done = true;
            }
          }
        }
        if (!done) { w.w(0, 3); w.wRawString(key); }
        var entries = pools[key];
        wCount(w, entries.length, 4, 'Starting Pool entries');
        entries.forEach(function (p) {
          var pi = POLARITIES.indexOf(p);
          if (pi < 1) {
            throw CodecError('Starting Pool entry outside the schema: ' + p);
          }
          w.w(pi, 4);
        });
      });
      return w.acc;
    }

    function decodeState(r) {
      var version = r.r(4);
      if (version < 1 || version > SCHEMA_VERSION) {
        throw CodecError('unsupported share code version ' + version);
      }
      var st = { version: 13 };
      st.category = CATEGORIES[r.r(4)];
      var intent = r.r(2);
      st.intent = intent === 1 ? 'upkeep' : intent === 2 ? 'hybrid' : 'window';
      st.hybridAllowance = r.rBool() ? 2 : 1;
      st.channelPreference = r.rBool() ? 'duration' : 'efficiency';
      st.spareShards = r.rBool();
      // v3 field; v1/v2 payloads take the migration default.
      st.omniAura = version >= 3 ? r.rBool() : false;
      st.selections = {};
      SELECTION_KEYS.forEach(function (k) {
        var mode = r.r(2);
        if (mode === 0) st.selections[k] = null;
        else if (mode === 1) st.selections[k] = r.rIndex(SELECTION_NS[k]);
        else if (mode === 2) st.selections[k] = r.rRawString();
        else throw CodecError('share code is malformed (selection mode 3)');
      });
      st.parts = {};
      PART_SLOTS.forEach(function (ps) {
        if (!st.parts[ps[0]]) st.parts[ps[0]] = {};
        st.parts[ps[0]][ps[1]] = r.rIndex(ps[2]);
      });
      st.attackByItem = {};
      var na = r.r(4);
      for (var i = 0; i < na; i++) {
        var km = r.r(3), key;
        if (km === 0) key = r.rRawString();
        else if (km === 1) key = r.rIndex('frames');
        else if (km === 2) key = r.rIndex('necramechs');
        else if (km === 3) key = r.rIndex('companions');
        else if (km === 4) {
          var wns = ['weapon:Primary', 'weapon:Secondary', 'weapon:Melee',
            'weapon:Archgun', 'weapon:Archmelee', 'weapon:Companion Weapon'];
          key = r.rIndex(wns[r.r(3)]);
        } else throw CodecError('share code is malformed (attack key mode)');
        st.attackByItem[key] = r.r(5);
      }
      // Version gate: v≤3 payloads carry the 9-key target list,
      // v4 the 12-key list (plus the glide migration below), v5
      // the full 13.
      st.frameTargets = rTargets(r, version >= 5 ? FRAME_STAT_KEYS : version === 4 ? FRAME_STAT_KEYS_V4 : FRAME_STAT_KEYS_V3);
      if (version === 4) migrateV4GlideTargets(st);
      st.weaponTargets = rTargets(r, WEAPON_STAT_KEYS);
      st.dmgTargets = rTargets(r, DMG_STAT_KEYS);
      st.ampTargets = rTargets(r, AMP_STAT_KEYS);
      st.locks = {};
      CATEGORIES.forEach(function (c) {
        var p = rPieces(r, true);
        if (p) st.locks[c] = p;
      });
      st.excludes = {};
      CATEGORIES.forEach(function (c) {
        var p = rPieces(r, false);
        if (p) st.excludes[c] = p;
      });
      st.helminthMode = r.rBool() ? 'choose' : 'auto';
      if (r.rBool()) {
        st.helminthChoice = { donor: r.rIndex('helminthDonors'), replacesIndex: r.r(2) };
      } else st.helminthChoice = { donor: '', replacesIndex: 0 };
      st.focusSchool = r.rBool() ? r.rIndex('focusSchools') : null;
      var cgOn = r.rBool();
      var inc = [], ni = r.r(4);
      for (i = 0; i < ni; i++) inc.push({ mod: r.rIndex('mods') });
      var exc = [], ne = r.r(4);
      for (i = 0; i < ne; i++) {
        exc.push(r.rBool() ? r.rIndex('sets') : r.rIndex('mods'));
      }
      st.crossGear = { on: cgOn, include: inc, exclude: exc };
      st.board = rBoard(r, st.selections, st.parts, version);
      st.routesFrame = {};
      ROUTES_FRAME_KEYS.forEach(function (k) { st.routesFrame[k] = r.rBool(); });
      st.routesWeapon = {};
      ROUTES_WEAPON_KEYS.forEach(function (k) { st.routesWeapon[k] = r.rBool(); });
      st.ampConditional = r.rBool();
      st.abilityLocks = {};
      var nf = r.r(5);
      for (i = 0; i < nf; i++) {
        var fname = r.rIndex('frames');
        var ln = r.r(3), arr = [];
        for (var j = 0; j < ln; j++) arr.push(r.rBool());
        st.abilityLocks[fname] = arr;
      }
      st.wallet = {};
      COLOURS.forEach(function (c) {
        if (r.rBool()) {
          st.wallet[c] = { normal: r.r(10), tauforged: r.r(10),
                           canFuseAscent: r.rBool() };
        } else st.wallet[c] = { normal: 0, tauforged: 0, canFuseAscent: false };
      });
      st.canFuseCoalescent = r.rBool();
      st.forma = rForma(r);
      st.umbraForma = r.r(5);
      st.ownerStats = { health: r.rNumStr(), shield: r.rNumStr(), armor: r.rNumStr() };
      st.progenitor = {
        element: PROGENITOR_ELEMENTS[r.r(3)],
        percent: parseFloat(r.rNumStr())
      };
      // v6 (v1.9.0): the trailing block; v≤5 payloads end at the
      // progenitor and gain the defaults.
      st.formaConvert = false;
      st.startingPools = {};
      if (version >= 6) {
        st.formaConvert = r.rBool();
        var np = r.r(5);
        for (i = 0; i < np; i++) {
          var km2 = r.r(3), pkey;
          if (km2 === 0) pkey = r.rRawString();
          else if (km2 === 1) pkey = r.rIndex('frames');
          else if (km2 === 2) pkey = r.rIndex('necramechs');
          else if (km2 === 3) pkey = r.rIndex('companions');
          else if (km2 === 4) {
            var wns2 = ['weapon:Primary', 'weapon:Secondary', 'weapon:Melee',
              'weapon:Archgun', 'weapon:Archmelee', 'weapon:Companion Weapon'];
            pkey = r.rIndex(wns2[r.r(3)]);
          } else throw CodecError('share code is malformed (pool key mode)');
          var pn = r.r(4), parr = [];
          for (var pj = 0; pj < pn; pj++) {
            var pv = POLARITIES[r.r(4)];
            if (!pv) {
              throw CodecError('share code is malformed (pool entry)');
            }
            parr.push(pv);
          }
          st.startingPools[pkey] = parr;
        }
      }
      if (r.remaining() !== 0) {
        throw CodecError('share code is malformed (trailing bits)');
      }
      return st;
    }

    // ---- base62 shell --------------------------------------------------
    function toBase62(value) {
      if (value === 0n) return '0';
      var out = '';
      while (value > 0n) {
        out = B62.charAt(Number(value % 62n)) + out;
        value = value / 62n;
      }
      return out;
    }
    function fromBase62(str) {
      var value = 0n;
      for (var i = 0; i < str.length; i++) {
        var d = B62.indexOf(str.charAt(i));
        if (d < 0) throw CodecError('share code has characters outside base62');
        value = value * 62n + BigInt(d);
      }
      return value;
    }

    function checksumOf(body) {
      var h = 0;
      for (var i = 0; i < body.length; i++) {
        h = (h * 33 + B62.indexOf(body.charAt(i))) % 3844;
      }
      return h;
    }
    function encode(state) {
      if (!state || typeof state !== 'object') return null;
      try {
        var body = toBase62(encodeState(state));
        var ck = checksumOf(body);
        var ckStr = B62.charAt(Math.floor(ck / 62)) + B62.charAt(ck % 62);
        return body + ckStr;
      } catch (e) {
        if (e && e.codec) {
          if (typeof process !== 'undefined' && process.env &&
              process.env.SHARE_CODEC_DEBUG) throw e;
          return null;
        }
        throw e;
      }
    }
    function decode(code) {
      if (typeof code !== 'string' || code.length < 3) {
        throw CodecError("this share code doesn't check out (too short)");
      }
      for (var i = 0; i < code.length; i++) {
        if (B62.indexOf(code.charAt(i)) < 0) {
          throw CodecError("this share code doesn't check out (bad characters)");
        }
      }
      var body = code.slice(0, -2);
      var ckGiven = B62.indexOf(code.charAt(code.length - 2)) * 62 +
                    B62.indexOf(code.charAt(code.length - 1));
      if (checksumOf(body) !== ckGiven) {
        throw CodecError("this share code doesn't check out (checksum mismatch)");
      }
      var value = fromBase62(body);
      if (value === 0n) throw CodecError('share code is malformed');
      var bits = value.toString(2);
      if (bits.charAt(0) !== '1') throw CodecError('share code is malformed');
      return decodeState(new Reader(bits.slice(1)));
    }
    function isCode(str) {
      if (typeof str !== 'string' || str.length < 3) return false;
      for (var i = 0; i < str.length; i++) {
        if (B62.indexOf(str.charAt(i)) < 0) return false;
      }
      return true;
    }

    return { encode: encode, decode: decode, isCode: isCode, SCHEMA_VERSION: SCHEMA_VERSION };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ShareCodec = api;
})();
