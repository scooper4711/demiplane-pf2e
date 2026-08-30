# Design: GM Slug Mapping

**Status:** Draft for review — no code written yet.
**Requirements:** [REQUIREMENTS-slug-mapping.md](./REQUIREMENTS-slug-mapping.md)
**Scope:** Design only. Once approved, the decisions here should be folded into `DESIGN.md` as
numbered decisions (currently at #17).

---

## 1. Context: how slugs resolve today

Imports convert Demiplane engine entries into compendium items through a handful of shared
resolvers. Every path that can fail currently pushes a **human-readable string** onto
`ImportSummary.unresolved` (`src/import/types.ts:16-23`), which `module.ts:208-212` copies onto the
actor as an import issue:

| Resolver                                                          | Used by                                                | Failure site                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `resolveCompendiumItem` (`compendium-resolver.ts:51`)             | ancestry, heritage, background, class, feat, equipment | `phases.ts:144`, `phases.ts:297`                                                               |
| `resolveSpellFromCompendium` (`compendium-resolver.ts:33`)        | all spell paths                                        | `spell-importer.ts:150,231,481`, `feature-spell-resolver.ts:240`, `item-spell-resolver.ts:149` |
| `findBySlug` on the equipment index (`equipment-importer.ts:215`) | equipment only                                         | `equipment-importer.ts:230`                                                                    |

`resolveCompendiumItem` searches `PACKS` (`types.ts:3-12`) trying `generateSlugCandidates`
(exact, class-suffix-stripped, `bloodline-` prefixed). Kind is derived from the engine path by
`categorizeEngine` (`slug-utils.ts:49`) into `ItemCategory` (`types.ts:36`: `ancestry | heritage |
background | class | feat | equipment`).

Two consequences matter for this feature:

1. **The failure record is a string.** `"Could not import equipment \"religious-symbol\": not found
in compendium"` can't drive a UI without parsing, which is brittle. We need structured data.
2. **There are exactly three lookup choke points.** If mappings are consulted in
   `resolveCompendiumItem`, `findSpellDocument`, and the equipment `findBySlug` step, every import
   path is covered without touching individual importers.

---

## 2. Decision 1 — Structured records replace the message strings

**Decision:** Replace `ImportSummary.unresolved: string[]` with a structured
`unmapped: UnmappedSlug[]`. The structured record is the **only** record; human-readable text is
**derived** from it at display time.

```ts
export type SlugKind = "ancestry" | "heritage" | "background" | "class" | "feat" | "equipment" | "spell";

export interface UnmappedSlug {
  /** Demiplane slug as it arrived (e.g. "religious-symbol-rm"). */
  slug: string;
  /** What kind of thing it was, for grouping and browser-tab selection. */
  kind: SlugKind;
}

/** The single place a human-readable message comes from. */
export function formatUnmapped(record: UnmappedSlug): string {
  return `Could not import ${record.kind} "${record.slug}": not found in compendium`;
}
```

**Rationale:** Two representations of the same event can disagree, and the string form can't drive
the mapping UI. Since the module is **unreleased there is no persisted data to migrate**, so the
cost of getting the model right is only the rework, not a migration — and the rework is bounded
(the sync dialog, the titlebar dot, and their tests). Carrying a legacy string field forward would
leave a second source of truth in the codebase permanently for the sake of avoiding work we can do
once, now.

**Tradeoffs:**

| Option                                                      | Pros                                           | Cons                                              |
| ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Replace `unresolved[]` with structured records **(chosen)** | One source of truth; display derived; UI-ready | Reworks the dialog, dot, and their tests          |
| Add `unmapped[]` alongside `unresolved[]`                   | Non-breaking; display untouched                | Two records of the same event; drift risk forever |
| Parse strings in the UI                                     | No import changes                              | Brittle; freezes the message format               |

### Consequences to carry through the rest of the design

1. **`ImportSummary`** (`types.ts:18`) drops `unresolved` in favour of `unmapped: UnmappedSlug[]`.
   `errors` stays as-is for genuine errors.
2. **Display is derived.** `demiplane-info-button.ts` renders `[...unmapped.map(formatUnmapped),
...importIssues]`, so the sync dialog text is unchanged even though the stored form changed.
3. **Actor persistence** stores the structured records under a new `unmappedSlugs` flag rather than
   flattened strings (see Decision 3).
4. **`module.ts:208-212`** records structured records instead of strings.
5. **Tests** that assert on `summary.unresolved` or on the exact dialog string are updated — the
   latter should still pass unchanged once `formatUnmapped` preserves the wording.

### The one non-slug case

`attribute-language-importer.ts:204` currently pushes a _languages_ message
(`"Languages not found in Foundry: …"`), which is not a mappable slug. It moves to
`summary.errors`, keeping `unmapped` exclusively for slug→compendium failures. If more
non-slug issue types appear later, `unmapped` can be widened to a discriminated union; that's not
needed now.

---

## 3. Decision 2 — Where records are captured

**Decision:** Each failure site pushes `{ slug, kind }` onto `summary.unmapped`, using the kind it
already has in hand. No message is constructed at the capture site.

| Site                                                         | Kind source                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `SequentialItemsPhase.addItemToActor` (`phases.ts:144`)      | the `category` argument (`ancestry`/`heritage`/`background`/`class`) |
| `BatchItemsPhase.run` (`phases.ts:296`)                      | the `category` argument (`feat`/`equipment`)                         |
| equipment `buildEquipmentItem` (`equipment-importer.ts:230`) | `"equipment"`                                                        |
| spell paths (4 sites)                                        | `"spell"`                                                            |
| `attribute-language-importer.ts:204`                         | none — moves to `summary.errors` (see §2)                            |

Each site also keeps its `- <kind>: <slug> (not found)` line in `summary.log`, which is diagnostic
console output rather than a data record and is unaffected.

**Rationale:** Each site already knows its kind; no inference needed. `feat` and `equipment` are
separate categories in `ItemCategory`, so "class feat slug vs item slug" — explicitly called out in
the requirements — falls out naturally.

**Note:** `categorizeEngine` returns `null` for class features (`slug-utils.ts:50`), which are
handled by the grant mechanism instead. Those therefore never appear as unmapped, which is correct.

---

## 4. Decision 3 — Storage: derived from actors, not a world registry

**Decision:** Persist each actor's `unmapped[]` **as structured records** under a new
`unmappedSlugs` actor flag, replaced wholesale each import. The settings screen **aggregates**
across all actors on open.

This keeps the actor's stored form identical to `ImportSummary.unmapped` — the structured record is
the single source of truth end to end, and the sync dialog formats it with `formatUnmapped` on the
way to the screen.

`sync-issues.ts` therefore grows a small structured API alongside the existing string-based one:

```ts
getUnmappedSlugs(actor): UnmappedSlug[];
setUnmappedSlugs(actor, records): Promise<void>;   // called at import start to reset
```

`importIssues` remains for non-slug issues (e.g. the languages message, import errors), and
`hasActiveIssues` / the titlebar dot consider both.

**Rationale:** A world-side "known unmapped slugs" registry would need pruning when a mapping is
added, when content changes, or when an actor is deleted. Deriving the list means it
self-corrects: import with a mapping in place → the slug resolves → no record → it vanishes from
the screen. This directly satisfies R1.5 and R4.4 with no reconciliation code.

**Tradeoffs:**

| Option                             | Pros                                                 | Cons                                                  |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Aggregate from actors **(chosen)** | Self-healing; no pruning; shows per-character impact | Needs a full scan on open (cheap: actors are few)     |
| World registry of unmapped slugs   | Single read                                          | Must be pruned on mapping/content change/actor delete |

Mappings themselves **are** a world setting (they must outlive any one actor).

---

## 5. Decision 4 — Resolution: mappings first, then compendium

**Decision:** A new `slug-mapping.ts` module owning the settings and lookup:

```ts
type SlugKind = "ancestry" | "heritage" | "background" | "class" | "feat" | "equipment" | "spell";

interface SlugMapping {
  uuid: string;
  name: string;
}

// One world-scoped setting per kind, each a slug → target map.
// e.g. setting "slugMappingsEquipment" = { "religious-symbol": { uuid, name } }
function getMapping(kind: SlugKind, slug: string): SlugMapping | undefined;
async function resolveMappedItem(kind: SlugKind, slug: string): Promise<Record<string, unknown> | null>;
function setMapping(kind: SlugKind, slug: string, mapping: SlugMapping): Promise<void>;
function clearMapping(kind: SlugKind, slug: string): Promise<void>;
```

`resolveMappedItem` is consulted at the **top** of `resolveCompendiumItem`, `findSpellDocument`,
and the equipment path (before `findBySlug`). If it returns an item, that item is used and nothing
else runs.

**Rationale:** The requirement says mapping "should be done first" (R4.1), and consulting first
also lets a GM override a slug that technically resolves but resolves to the _wrong_ thing —
including the built-in normalization rules (`magic-scroll-*-rank` → `scroll-of-2nd-rank-spell`).
Decision 2 in the requirements confirms this is deliberate: a later phase is expected to surface
automatic mappings so a GM can override ones they disagree with.

**Keying — resolved: scoped by kind** (requirement decision 4). Two parts:

- The **setting** is per kind (`slugMappingsEquipment`, `slugMappingsFeat`, `slugMappingsSpell`,
  `slugMappingsAncestry`, `slugMappingsHeritage`, `slugMappingsBackground`, `slugMappingsClass`)
  rather than one monolithic object (requirement decision 5). Each is
  `Record<slug, SlugMapping>`. Because the kind is implied by which setting the entry lives in, it
  is not repeated inside `SlugMapping`.
- The **key within a setting** is the raw Demiplane slug. All three choke points receive the raw
  slug before any normalization, so this is stable.

This means two kinds sharing a slug cannot collide — which is the desired behaviour anyway, since a
mapping points at a particular kind of compendium entry and carrying one across kinds would
usually be wrong.

**Missing target handling (R4.3):** if `fromUuid(mapping.uuid)` returns null — uninstalled pack,
removed content — `resolveMappedItem` returns `null`, the normal lookup runs, and the slug is
recorded unmapped again. The screen shows these as "mapped, but target missing" rather than
silently dropping them.

**Tradeoffs:**

| Precedence                     | Pros                                                                      | Cons                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mapping first **(chosen)**     | GM has final say; matches R4.1; can override wrong-but-successful matches | A bad mapping can override good content — mitigated by making overrides visible later |
| Mapping only on lookup failure | Can't break working imports                                               | GM can't fix a wrong-but-successful match                                             |

**Note on equipment:** the equipment path normalizes the slug (`magic-scroll-2nd-rank` →
`scroll-of-2nd-rank-spell`) before searching. The mapping check goes **before** normalization, so a
GM maps the slug exactly as Demiplane reports it.

---

## 6. Decision 5 — UI: ApplicationV2 + Handlebars, registered as a settings menu

**Decision:** `SlugMapperApp extends
foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2)`,
registered with `game.settings.registerMenu(..., { type: SlugMapperApp, restricted: true })`.

**Rationale:** This is exactly how PF2e registers its own GM settings screens — see
`src/module/system/settings/variant-rules.ts:169-181` (registration, `restricted: true`) and
`:7-26` (the AppV2 with `DEFAULT_OPTIONS`/`PARTS`/`form.handler`). `restricted: true` makes it
GM-only for free (R2.1, criterion 7). The module already uses `ApplicationV2` conventions
elsewhere (`DialogV2` in `demiplane-info-button.ts`).

Structure mirrors PF2e's compendium-browser settings app
(`src/module/apps/compendium-browser/settings.ts:29-55`), whose `scrollable: [".settings-container"]`
part is precisely what a long slug list needs:

```
PARTS = {
  list:   { template: "modules/demiplane-pf2e/templates/slug-mapper.hbs",
            scrollable: [".slug-list"] },
  footer: { template: "templates/generic/form-footer.hbs" },
}
```

Templates are registered in `Hooks.once("init")` via `foundry.applications.handlebars.loadTemplates`
(PF2e's equivalent: `src/scripts/register-templates.ts:151-153`).

**Sections:** group by kind, each with a header and count (R2.3), matching how the PF2e inventory
renders separate sections per item type — and like the inventory, the **magnifying glass lives on
the section header**, not on every entry (`templates/actors/partials/inventory.hbs:29-33`).

```
EQUIPMENT (3)                                          [🔍]

  [icon] religious-symbol          affected: Kyra, Ezren
         → Wooden Religious Symbol                    [clear]

  [icon] magic-scroll-2nd-rank     affected: Kyra
         — not mapped —                               [clear]

FEAT (1)                                               [🔍]

  [icon] haughty-obstinacy         affected: Ezren
         — not mapped —                               [clear]
```

Every row is a drop target. Empty state when there are no unmapped slugs (R2.7).

---

## 7. Decision 6 — Compendium Browser integration

**Decision:** Each **section header's** magnifying glass opens the PF2e Compendium Browser with the
tab and filter for that kind. It is opened **once per kind** and left open; the GM filters it
themselves and drags from it repeatedly.

**Rationale:** Reopening the browser per slug would be tedious and would wrongly imply that a fresh
browser is needed for each row (R3.1). The browser is a _finder_; the drop is the action that
matters (R3.2). This also matches the inventory page, where one browse button serves a whole
section rather than each item.

**Consequences:**

- The mapping screen must be **non-modal** so it stays interactive next to the open browser
  (R3.3). `ApplicationV2` is non-modal by default; we must simply not set `modal: true`.
- No search seeding. With one browser serving many rows there is no single slug to search for, and
  PF2e wipes `filter.search.text` on close anyway (`browser.ts:105-110`). This sidesteps the
  seeding caveat noted earlier.
- The browser is a single shared instance, so clicking a different section's glass re-tabs the
  same window rather than opening another.

**Mechanism** (verified against `~/git/pf2e`):

- Browser class: `src/module/apps/compendium-browser/browser.ts:17`
- Assigned to `game.pf2e.compendiumBrowser` **on ready** (`src/scripts/set-game-pf2e.ts:171-174`) —
  so it must only be touched from a click handler, never at init.
- `tab.getFilterData()` (`tabs/base.svelte.ts:124-129`) initializes the tab and returns a clean
  filter; `tab.open({ filter })` (`tabs/base.svelte.ts:116-121`) opens it.
- The pattern to copy is `#onClickBrowseEquipment` (`src/module/actor/sheet/base.ts:980-1010`):
  mutate `filter.checkboxes.itemTypes` (setting **both** `options[key].selected` and pushing to
  `selected[]`), then `tab.open({ filter })`.
- Text search lives at `filter.search.text` (`tabs/data.ts:74-80`). We don't seed it (see above).

**Tab mapping:**

| Kind      | Browser tab                          | Filter                                      |
| --------- | ------------------------------------ | ------------------------------------------- |
| equipment | `equipment` (`tabs/equipment.ts:11`) | item types for the kind; search text = slug |
| feat      | `feat` (`tabs/feat.ts:8`)            | search text = slug                          |
| spell     | `spell` (`tabs/spell.ts:10`)         | search text = slug                          |

Tab names are a closed union — `data.ts:25-28`: `action | bestiary | campaignFeature | equipment |
feat | hazard | spell`.

**The gap — resolved: (b) then (c).** Ancestry, heritage, background, and class have no tab. For
those kinds the magnifying glass opens the **raw compendium pack** in Foundry's own pack browser;
if the pack isn't available, no glass is rendered for that section and the GM drags from the
Compendium sidebar instead.

| Kind       | Magnifying glass opens                                 |
| ---------- | ------------------------------------------------------ |
| equipment  | Compendium Browser, `equipment` tab + item-type filter |
| feat       | Compendium Browser, `feat` tab                         |
| spell      | Compendium Browser, `spell` tab                        |
| ancestry   | pack `pf2e.ancestries`; no glass if absent             |
| heritage   | pack `pf2e.heritages`; no glass if absent              |
| background | pack `pf2e.backgrounds`; no glass if absent            |
| class      | pack `pf2e.classes`; no glass if absent                |

All four fallback packs are already in `PACKS` (`types.ts:3-12`), so they're known-good keys.

This is acceptable because the glass is a convenience, not a required control: it lives on the
section header (§6), drag-and-drop is the primary interaction (§8), and a GM can always reach the
items through the Compendium sidebar.

---

## 8. Decision 7 — Drag and drop (the primary interaction)

**Decision:** Every unmapped row is a drop target. Accept `text/plain`, expect `{ type, uuid }`,
resolve via `fromUuid`, and store the target's UUID plus display name.

**Rationale:** Dropping is what creates a mapping; the browser only helps locate items (R3.2). So
the drop target needs a clear affordance — a visible hover state on `dragover` — and the row must
stay droppable even after it has a mapping, so a GM can correct it by dropping again.

**Mechanism** (verified against `~/git/pf2e`):

- The browser sets `text/plain` to `JSON.stringify({ type, uuid })`
  (`src/module/apps/compendium-browser/components/result-item.svelte:43-49`).
- Only `type` and `uuid` are reliable; PF2e resolves through the UUID and never reads `pack`/`id`.
- The idiomatic parse is `getItemFromDragEvent` (`src/module/sheet/helpers.ts:122-131`), or
  `ItemPF2e.fromDropData` directly.
- AppV2 apps attach plain listeners (`_attachPartListeners` → `addEventListener("drop", …)`), as in
  `src/module/item/base/sheet/rule-element-form/base.ts:217-229`. Remember `preventDefault()` on
  both `dragover` and `drop`.

Validation: reject non-`Item` drops with a `ui.notifications.warn` (R3.6).

**Type mismatch — resolved: block with an explanatory dialog** (requirement decision 3). If the
dropped item's type doesn't match the slug's kind, refuse the mapping and show a `DialogV2`
explaining what was expected versus what was dropped — e.g. _"‘religious-symbol’ is an equipment
slug, but you dropped the spell ‘Heal’. Map it in the Spells section instead."_ Not a bare warning,
and not silently allowed.

The expected item type per kind:

| Kind       | Expected `item.type`                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| equipment  | one of the physical item types (weapon, armor, equipment, consumable, treasure, backpack) |
| feat       | `feat`                                                                                    |
| spell      | `spell`                                                                                   |
| ancestry   | `ancestry`                                                                                |
| heritage   | `heritage`                                                                                |
| background | `background`                                                                              |
| class      | `class`                                                                                   |

---

## 9. Testing strategy

New unit tests:

- `formatUnmapped` produces the existing wording, so dialog text is unchanged.
- Each capture site records `{ slug, kind }` with the expected kind; none build a message.
- The languages failure lands in `errors`, not `unmapped`.
- Actor round-trip: `setUnmappedSlugs` → `getUnmappedSlugs` preserves records; re-importing
  replaces them rather than accumulating.
- `resolveMappedItem` returns the mapped item and short-circuits the compendium lookup.
- Mapping takes precedence over a slug that would otherwise resolve.
- A mapping whose UUID no longer resolves falls through and re-records the slug as unmapped.
- **Per-kind keying:** the same slug mapped under two kinds stays independent; clearing one leaves
  the other intact. Each kind writes only its own setting.
- Aggregation: slugs from several actors merge, grouped by kind, with the actor list.
- Drop handling: accepts `{type:"Item",uuid}`, rejects other types, and re-mapping an already
  mapped row replaces the target.
- **Type mismatch:** dropping a spell on an equipment slug stores nothing and surfaces the
  explaining dialog.
- **Fallback kinds:** a no-tab kind opens its pack; if the pack is missing, no glass is rendered
  and the section still accepts drops.
- The section header opens the browser once per kind (one call per click, correct tab).
- The app is configured non-modal, so it stays usable beside the open browser.

The existing mocks need `foundry.utils.randomID` (added for the scroll/wand work) and a
`game.pf2e.compendiumBrowser` stub with `tabs` exposing `getFilterData`/`open`, so browser-tab
selection is testable without a live PF2e instance.

Manual verification in Foundry: import a character with an unmapped slug, map it via the screen,
re-import, and confirm the item arrives with no import issue — the same loop used to verify the
scroll/wand fix.

---

## 10. Risks

| Risk                                                   | Impact                                         | Mitigation                                                                      |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Ancestry/heritage/background/class have no browser tab | Magnifying glass can't open a filtered browser | Fall back to rendering the pack (see §7)                                        |
| Mapping keyed by slug alone could collide across kinds | Wrong item used                                | Resolved — mappings are scoped per kind (§5), so collisons are impossible       |
| `game.pf2e.compendiumBrowser` only exists after ready  | Crash if touched at init                       | Access lazily inside click handlers only                                        |
| Browser wipes `search.text` on close                   | Seeded search may not persist                  | Treat as convenience; the row shows the slug                                    |
| Large mapping sets bloat the setting object            | Slow settings sync                             | Acceptable — mappings are small `{uuid,name,kind}` records; revisit if it grows |

---

## 11. Implementation plan

Ordered so each step is independently verifiable:

1. **Data model** — `SlugKind` / `UnmappedSlug` / `formatUnmapped`; swap
   `ImportSummary.unresolved` for `unmapped: UnmappedSlug[]`. Update `types.ts`, the six capture
   sites, and the languages case. No behaviour change yet.
2. **Rework the consumers** — `module.ts:208-212` records structured records; `sync-issues.ts`
   gains `getUnmappedSlugs` / `setUnmappedSlugs`; the sync dialog and titlebar dot render
   `formatUnmapped` output. Update every test that touched `unresolved`. **The dialog's visible
   text must be byte-identical after this step** — that's the acceptance check.
3. **`slug-mapping.ts`** — register one world setting per kind, `getMapping` / `setMapping` /
   `clearMapping` / `resolveMappedItem`. No UI yet.
4. **Resolution hooks** — consult mappings in `resolveCompendiumItem`, `findSpellDocument`, and the
   equipment path. Tests for precedence and missing-target fallback.
5. **`SlugMapperApp`** — template, parts, aggregation, sections, empty state, registerMenu.
6. **Browser integration** — one magnifying glass per section header, correct tab per kind,
   including the no-tab fallback; app stays non-modal.
7. **Drag and drop** — drop zones with hover affordance, validation, type-mismatch dialog,
   clear/remove action.
8. **End-to-end** — verify in Foundry with a real unmapped slug (`religious-symbol`).

Steps 1–4 are the functional core and usable before any UI exists; 5–7 are presentation. Step 2 is
the bulk of the rework that Decision 1 accepts, and landing it early keeps it from colliding with
new work.

---

## 12. Future considerations (explicitly out of scope)

- **GMs submitting mappings upstream.** A GM who has mapped the long tail for their group could
  send those mappings back, and the good ones could become built-in normalization rules — exactly
  how `magic-scroll-*-rank` → `scroll-of-2nd-rank-spell` landed in `slug-utils.ts`. This argues for
  keeping the mapping format simple and self-describing (`slug` → `uuid`) so a future export is
  trivial, but no submission flow is built now (requirement N6).
- **Surfacing automatic mappings.** Since mappings are consulted first, a GM may want to see (and
  override) the normalizations that already happen in code. Not needed for v1.
- **Suggestions.** Seed the browser's search with the unresolved slug, or propose likely matches,
  to cut down manual hunting (requirement N2).

---

## Appendix A — Key references

**This module:**

- `src/import/types.ts:16-23` `ImportSummary`; `:36` `ItemCategory`; `:3-12` `PACKS`
- `src/import/slug-utils.ts:49` `categorizeEngine`
- `src/import/compendium-resolver.ts:33,51` spell/generic resolvers
- `src/import/phases.ts:143-144, 296-297` capture sites
- `src/module.ts:208-212` unresolved → import issues
- `src/settings.ts:8-40` settings registration and the `renderSettingsConfig` button pattern

**PF2e** (all under `~/git/pf2e`):

- `src/module/apps/compendium-browser/browser.ts:17,147-186` browser class and `openTab`
- `src/module/apps/compendium-browser/data.ts:25-28` `TabName` union
- `src/module/apps/compendium-browser/tabs/base.svelte.ts:116-129` `open` / `getFilterData`
- `src/module/actor/sheet/base.ts:980-1010` `#onClickBrowseEquipment` — the pattern to copy
- `src/module/sheet/helpers.ts:122-131` `getItemFromDragEvent`
- `src/module/system/settings/variant-rules.ts:7-26,169-181` AppV2 settings screen + `registerMenu`
- `src/scripts/set-game-pf2e.ts:171-174` `game.pf2e.compendiumBrowser` assigned on ready
