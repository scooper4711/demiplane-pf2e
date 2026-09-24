# Scratch: Starfinder (SF2e) support investigation

> DRAFT / SCRATCH — working notes, not a design doc. No code changes made on
> the basis of this file yet.

## Sources

- Demiplane Starfinder test character ("Sunesh"):
  `6c52ec58-5d7d-480f-8266-bbe0a6c47e72`
  (nexus_id `100`, `asset_slug: starfinder2e`, sheet `cosmic-hero`;
  Kyra for comparison is nexus_id `1`, `pathfinder-2e`).
- PF2e/SF2e system source at `~/git/pf2e` (foundryvtt/pf2e repo, v14-dev):
  one codebase, two builds selected by the `SYSTEM_ID` env flag
  (`pf2e` 8.4.1 / `sf2e` 1.4.1). Native SF2e packs under `packs/sf2e/`.

## What works already (or nearly)

- Demiplane models Starfinder characters on the **same engine system** as
  PF2e: same `core/character.eng` root, same
  `tabula/ancestry|heritage|background|class|feat|item` shapes, same custom
  store names (`character_hit-points_current`), cache IDs under
  `pathfinder2e-v2`. Sunesh: 56 engines, 24 tabula + 15 custom.
- The sf2e build keeps `game.pf2e`, `CONFIG.PF2E`,
  `RuleElements.builtin.ChoiceSet`, and the compendium-browser tabs
  (equipment/feat/spell) — names are hardcoded, only packs/lang/banners vary
  by build flag. Our libWrapper target, browser integration, and language
  lookups keep working.
- Native `sf2e.*` packs use identical item type strings (`ancestry`,
  `heritage`, `class`, `feat`, `spell`, …), and pack discovery + import
  fallback (added Sept 2026) find them automatically. Traditions are the same
  four. SF2e skills are a pure superset of PF2e (adds `computers`,
  `piloting`).
- Game system is detectable per character via `nexus_id` / `asset_slug`
  (`100` / `starfinder2e`) — no slug sniffing needed.

## Gaps found (static analysis, pre-import)

1. `module.json` declares `systems: [pf2e]` only — hard gate in sf2e worlds.
2. `VALID_SKILLS` (`attribute-language-importer.ts`) lacks
   `computers`/`piloting`; misses hit a silent `continue`. Sunesh's hacker
   background pushes computers — those ranks would vanish.
3. `DEMIPLANE_SHEET_BASE` hardcodes the `pathfinder2e` nexus path
   (`config.ts`) — SF sheet links 404 / land in the wrong game.
4. Currency is coin-shaped (`TREASURE_ITEM_MAP`: pp/gp/sp/cp); SF2e runs on
   credits/upb (persisted as sp). Unknown what engines Demiplane emits for a
   funded SF character — Sunesh carries none.
5. Hero Points vs Resolve on the export path (import side is benign: SF
   characters have no hero-points engine). Needs a live sf2e actor check.
6. `PACKS` / `EQUIPMENT_PACK` official-first degrades gracefully when pf2e
   packs are absent (skip → discovery finds `sf2e.*`), but the fallback
   becomes the primary path there — needs a dedicated test with pf2e packs
   absent.

## Live import results (sf2e world `starfinder-demiplane-test` on :30000)

Setup needed for the test: our `module.json` declares `systems: [pf2e]`,
and Foundry v14 **excludes system-incompatible modules from `game.modules`**
entirely (not just deactivates them) — so the module couldn't even load.
Temporarily added `sf2e` to relationships (LOCAL ONLY, will revert), enabled
it, set write level **read-only** + Demiplane token. Both imports below ran
read-only: Varielle's `updated` timestamp is byte-identical post-import
(Sept 9), proving imports never write back. (Sunesh's `updated` moved
08:35 → 08:42 from owner activity between probes, unrelated to our reads.)

### Sunesh (operative 3, `6c52ec58…`) — 26 items, 3 unmapped, 0 import errors

Worked: heritage (Artificial Scion Android, via new third-party fallback),
background (Hacker), class (Operative), 9 feats (all SF content), 8 equipment
items, lore skills, Aim action. Computers rank 1 landed — via the manual
proficiency-override path (`buildOverrideUpdates` has NO allowlist), which
masks finding 1 below.

Unmapped / missing:

- `android-sf` (ancestry): native `sf2e.ancestries` holds `Android=android`.
  Miss is purely Demiplane's `-sf` suffix convention — our candidates don't
  strip it. Downstream damage is real: Ancestry HP shows +0 (native android
  gives 8 → max should be ~35, shows 27), ancestry boosts never applied.
- `commercial-electromag-grenade-playtest`, `weapon-improvement-tactical`:
  genuinely absent from native packs (playtest content) — correctly unmapped.
- `tabula/item/basic-environmental-protection.eng` silently missing (NOT
  unmapped): its `sourceData` names the Android ancestry as granter, so the
  equipment importer skips it as element-granted — but the ancestry itself is
  unmapped, so the grant never materializes. Cascade gap: granted items of
  unmapped parents vanish without a trace.
- `tabula/feat/digital-diversion.eng` silently missing (NOT unmapped):
  `sourceRow: …_select-feat-infiltrator-…` — a class-granted choice consumed
  as "already granted", but the actor has no Digital Diversion. The
  specialization ChoiceSet resolved to **Sharpshooter** (with Aim action)
  with `unresolvedChoices: []` — no user prompt. Same on Varielle (Ghost →
  Sharpshooter). Systematic: SF operative specializations guess wrong,
  silently.
- Phreaker imported TWICE, both carrying our import stamp (no pf2e grant
  flag): the heritage GrantItem auto-created one, our pipeline created
  another, and `RemoveDuplicatesPhase` kept both ("grant-vs-import, exactly
  one stamped" heuristic defeated — suspected: reconcile stamps the
  grant-created copy too).

### Varielle Ta'nir (operative, `05779abe…`) — 24 items, 2 unmapped, 1 issue

Worked: Lashunta + Damaya auto-resolved from NATIVE `sf2e.*` packs (plain
slugs — the fallback path as designed), Xenoseeker, Operative, all 9
equipment items, Mobile Aim, Multilingual, Additional Lore, lores.

Gaps:

- `ancestral-skills-lashunta` (feat): compendium holds
  `Ancestral Skills=ancestral-skills`. Demiplane's `<feat>-<ancestry>`
  suffix convention — parallel to `-sf`. Fix shape: strip
  `-<the character's own ancestry slug>` in candidates (works for any
  ancestry, no list to maintain).
- `containers-ordinary` (equipment): Demiplane container-grouping
  pseudo-engine with no compendium counterpart. Probably benign (PF2e-side
  analog unknown) — verify before "fixing".
- `Languages not found in Foundry: akitonian.` — FALSE positive with teeth:
  `akitonian` IS a live key. Demiplane sent `"Formian, Elven, Khizar,
Akitonian."` (trailing period) → slugified `akitonian.` ≠ `akitonian`.
  Not SF-specific, just first observed here: strip trailing punctuation when
  slugifying the free-text language field.
- Specialization guess Sharpshooter-over-Ghost again, `unresolvedChoices:
[]` — confirms systematic (see Sunesh).

### Secondary observations

- Import dialog placeholder URL hardcodes the `pathfinder2e` nexus path —
  same hardcoded-nexus class as `DEMIPLANE_SHEET_BASE`; both need per-nexus
  URLs from `nexus_id`/`asset_slug`.
- Neither character was modified on Demiplane (read-only enforced + imports
  never write; Varielle timestamp unchanged). Dev-world actors Sunesh /
  Varielle Ta'nir are new imports; Test Cleric (pf2e world) restored to its
  exact original 12 items after exploration deleted its Bard (PF2e cascade
  takes granted feats with the class — rebuilt via the ABC picker + Maestro).

## Fix list (not started)

1. `module.json` systems + rename/migration (front door).
2. Per-character nexus (`nexus_id`/`asset_slug`) → sheet URLs, import
   placeholder, later system branching.
3. Skill validation against live actor skill keys, not `VALID_SKILLS`
   (computers/piloting + future-proof).
4. Slug candidates: strip `-sf` and `-<own-ancestry-slug>` suffixes.
5. Granted items of unmapped parents: import standalone or report (don't
   silently drop `basic-environmental-protection` class cases).
6. Specialization/choice fidelity: reproduce Infiltrator/Ghost vs
   Sharpshooter; ensure wrong guesses surface in `unresolvedChoices`.
7. Phreaker duplication: reconcile stamping vs dedup interaction.
8. Language free-text: strip trailing punctuation.
9. Currency: probe a funded SF character's engines (credits?) before design.
10. Hero Points vs Resolve + stamina on live sf2e actors (export path).
11. Dedicated test: fallback-as-primary with pf2e packs absent.
