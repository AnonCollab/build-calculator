# Warframe Build Calculator

An **inverse** build calculator for Warframe: instead of picking mods and seeing what stats come out, you pick the **target stats** you want — *at least* a value, or as *close* as possible — and the solver works out a build that lands there.

**Live site:** https://anoncollab.github.io/build-calculator/

Static GitHub Pages site. Vanilla HTML/CSS/JS, no build step, no external assets. Your inputs (item, targets, routes, shard wallet, Forma budget) are saved in your browser's localStorage, and builds can be shared via a link that encodes the setup in the URL hash.

## What works in v0.1

- **Warframe category solver** — all 126 Warframes, max-rank paper (arsenal) stats.
- **Per-stat target modes:** *Don't care* (side effects land here), *Closest* (minimise distance either direction), *At least* (hard floor — unmet floors are reported honestly, with the best effort and what might unlock more).
- **Routes the solver may use** (each toggleable): Mods (incl. partial ranks as a fine-tuning dial, Corrupted/Umbral/Archon/set mods), Arcanes, Archon Shards (normal + Tauforged, Ascent and Coalescent Fusion from your wallet), Aura, Exilus slot, Legacy Arcane Helmets (defaults **off**), Tome mods on a support Grimoire (cross-gear), and Conditional buffs (procced/stacking effects count only when on).
- **Resources are real constraints:** shard wallet counts per colour, Forma budget per item (with a slot-by-slot polarity plan in the result), mod capacity fitting.
- **Golden case, verified:** Follie with Ability Duration "at least 300" solves to **305% with zero Warframe mods** (Arcane Concentration + Arcane Ice Storm + Ris Invocation + 3× Tauforged Crimson shards).
- Tabs: Item / Targets / Routes & Resources / Results / Acquisition (every build piece links to its wiki page).

## Known limitations (v0.1)

- Only the **Warframe** category solves; Primary/Secondary/Melee/etc. are later milestones.
- **Set bonuses are not computed** — the wiki's derived set data is prose-only, so there are no numeric set bonuses to solve against yet.
- The **arcane pool is limited to a small curated layer** (the wiki's arcane store is prose-only; numeric effects are added as a curated, sourced layer — three duration arcanes ship in v0.1).
- Tome **Canticles** are excluded (their derived data doesn't mark whether the effect targets the player or enemies); stacking Invocations are included.
- Acquisition shows wiki links for every build piece; drop-source strings will appear if a future dataset keys sources by mod name.
- Paper stats only — no real-DPS simulation. Conditional effects are labelled and toggle-gated.

## Data

The site runs on a **data snapshot** (2026-10-18) extracted from the Warframe wiki — no live API calls. The local project pipeline (not in this repo) pulls the wiki's Lua data stores, derives numeric mod effects from the stores' description text with validator-checked pairing, extracts shard/Tome/aura/helmet tables from wiki pages, and trims everything into the `data/*.json` files served here. To refresh after a game update, the pipeline is re-run and the site files re-published; each release tag pins a site + data snapshot together.

Game data from the [Warframe wiki](https://wiki.warframe.com), CC BY-NC-SA 3.0. Warframe is a registered trademark of Digital Extremes. This is an unofficial fan tool, not affiliated with Digital Extremes.
