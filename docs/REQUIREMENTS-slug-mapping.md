# Requirements: GM Slug Mapping

**Status:** Draft for review — no code written yet.
**Goal:** Let a GM map Demiplane slugs that don't resolve programmatically onto real Foundry/PF2e compendium items, so any character import picks them up.

---

## 1. Problem

Every import resolves Demiplane slugs (e.g. `religious-symbol`, `magic-scroll-2nd-rank`) against
compendium item slugs. Some never match:

- Demiplane names generic items differently than the compendium (`magic-scroll-2nd-rank` vs
  `scroll-of-2nd-rank-spell`).
- Some items only exist with a qualifier (`religious-symbol` vs `religious-symbol-wooden`).
- Content gaps simply have no compendium equivalent.

Today these become import issues on the actor ("Could not import equipment
"religious-symbol": not found in compendium") and the item is silently skipped. The GM's only
recourse is to add the item to the character by hand after every import — and it will be wiped on
the next one, since manually added items survive but the gap never closes.

There is no finite set of these, so they can't all be fixed with hardcoded normalization rules
(the way `magic-scroll-*-rank` was in `slug-utils.ts`). This feature makes the remaining long tail
fixable by the GM without a code change.

---

## 2. Users and roles

| Role                 | Can do                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| GM (or Assistant GM) | Open the mapping screen, view unmapped slugs, add/edit/remove mappings |
| Player               | Nothing — this is GM-only                                              |

---

## 3. Functional requirements

### 3.1 Capturing unmapped slugs

- **R1.1** When an import fails to resolve a slug to a compendium item, the failure is recorded
  with structured data — the slug and the kind of thing it was (ancestry, heritage, background,
  class, feat, equipment, spell).
- **R1.2** The structured record is the **single source of truth**. Human-readable text is derived
  from it at display time; there is no separate stored message that could drift from it.

  _The module is unreleased, so there is no persisted data to migrate. Prefer a correct model over
  one that avoids reworking the sync dialog and its tests._

- **R1.3** Records are associated with the actor that was imported, so the screen can show which
  characters are affected. The stored form matches the in-memory form exactly.
- **R1.4** A slug that already has a mapping, or that resolves normally, produces no record.
- **R1.5** Re-importing an actor replaces its records (no stale accumulation). If a mapping or
  new content makes the slug resolve, the record disappears on its own.
- **R1.6** The text the GM sees in the sync dialog is unchanged in wording, even though it is now
  generated from the structured record.

### 3.2 The mapping screen

- **R2.1** Available to GMs from the module settings as its own screen, opened by a button.
- **R2.2** Lists every unmapped slug across **all** imported characters.
- **R2.3** Slugs are grouped into **sections by kind**, so the GM knows whether they're looking at
  a class feat slug, an equipment slug, a spell slug, etc. Each section shows a count.
- **R2.4** Each **section header** carries the magnifying glass for that kind (see R3.1).
- **R2.5** Each row shows: the slug, the characters affected by it, and the item it currently
  maps to (or a clear "not mapped" state). Rows are drop targets.
- **R2.6** Rows are searchable/filterable so a GM with many slugs can find one quickly.
- **R2.7** If there are no unmapped slugs, the screen says so rather than showing an empty list.

### 3.3 Mapping a slug

- **R3.1** Each **section header** has a **magnifying glass** that opens the PF2e Compendium
  Browser on the tab appropriate to that kind, with a sensible filter applied. It is opened **once
  per kind, not once per slug** — a per-row button would wrongly imply the GM must close and reopen
  the browser for every slug.
- **R3.2** The GM leaves that single browser open, manages filtering themselves, and **drags and
  drops** items from it onto any row in any section. Dragging is the primary interaction; the
  browser is only a way to find things.
- **R3.3** The Compendium Browser stays open and non-modal while the mapping screen is used. The
  mapping screen remains interactive — rows can be dropped onto and scrolled while the browser is
  open, and dropping a second item does not require reopening it.
- **R3.4** The mapped row shows the target item's name (and ideally its icon), so the mapping is
  verifiable at a glance.
- **R3.5** A mapping can be removed, returning the slug to unmapped.
- **R3.6** Dropping something that isn't a compendium item is rejected with a clear message
  rather than silently failing. Dropping an item whose **type doesn't match the slug's kind** is
  blocked with a dialog explaining what was expected versus what was dropped (decision 3).
- **R3.7** Because the GM filters the browser themselves, the screen does not need to seed the
  browser's search box. (Convenience seeding is optional; the browser clears its own search text on
  close anyway.)

### 3.4 Using mappings on import

- **R4.1** On any character import, a slug's mapping is checked **first**, before the normal
  compendium lookup. If a mapping exists it is used.
- **R4.2** Mappings apply to **every** character, not just the one that surfaced the slug.
- **R4.3** A mapping to a compendium item that no longer exists (uninstalled pack, changed
  content) degrades gracefully: fall back to normal lookup and record the slug as unmapped again,
  rather than breaking the import.
- **R4.4** Once a slug is mapped, it no longer appears as an import issue on the character.

---

## 4. Non-goals (this iteration)

- **N1** No bulk import/export of mappings between worlds. (Possible later via a JSON setting.)
- **N2** No fuzzy/suggested mappings — the GM picks the target explicitly. Auto-suggestion could
  come later using the unresolved slug as a search seed.
- **N3** No per-character mappings. Mappings are world-wide (see R4.2).
- **N4** No reverse direction: mappings are not used when **pushing** to Demiplane. Export
  already keys off the Demiplane slug stored on the item.
- **N5** No editing of a mapping's target by typing a UUID — drag and drop only for v1.
- **N6** No "submit my mappings upstream" flow. The idea is that GMs could one day send their
  mappings back for inclusion as built-in normalization rules (as was done for
  `magic-scroll-*-rank`). Real and worth doing, but out of scope for this iteration.
- **N7** No backup/export of mappings (see decision 5).

---

## 5. Decisions resolved during review

These were open questions; all five are now settled and are reflected in the requirements above.

1. **Kinds with no Compendium Browser tab — resolved: (b) then (c).**
   The PF2e Compendium Browser has exactly seven tabs (`action`, `bestiary`, `campaignFeature`,
   `equipment`, `feat`, `hazard`, `spell`), so ancestry, heritage, background, and class have
   nowhere to go. For those kinds the magnifying glass opens the **raw compendium pack**
   (`pf2e.ancestries`, `pf2e.heritages`, `pf2e.backgrounds`, `pf2e.classes`) in Foundry's own pack
   browser. If the pack isn't available, the glass is **omitted** for that section — mapping still
   works by dragging from the Compendium sidebar.

   _Consequence: this makes the glass a convenience rather than a required control, which is
   consistent with it living on the section header (R2.4) and with drag-and-drop being the primary
   interaction (R3.2)._

2. **Mapping precedence — resolved: mappings always applied first.**
   A mapping wins even when the slug would have resolved on its own (R4.1). The GM has the final
   say, including over automatic normalization rules like the `magic-scroll-*-rank` rewrite. A
   later phase is expected to make it easier for a GM to see and override an automatic mapping they
   disagree with.

3. **Type mismatch on drop — resolved: block with an explanatory dialog.**
   Dropping an item whose type doesn't match the slug's kind is refused, and a dialog explains what
   was expected versus what was dropped (R3.6). Not merely a warning, and not silently allowed.

4. **Slug key granularity — resolved: key by kind.**
   Mappings are scoped per kind (`kind` + `slug`), so two kinds sharing a slug can't collide. This
   is deliberate, not just defensive: a mapping points at a particular kind of compendium entry, so
   carrying one across kinds would usually be wrong anyway.

5. **Setting scope — resolved: one setting per kind.**
   Not one monolithic object. Each kind gets its own world-scoped setting (see
   `DESIGN-slug-mapping.md` §5). Backup/export of mappings is not in this iteration.

---

## 6. Acceptance criteria

1. A GM can open the mapping screen from module settings and see a sectioned list of every
   unmapped slug across all imported characters.
2. Clicking a **section's** magnifying glass opens the Compendium Browser on the tab for that kind.
3. Dragging an item from that browser onto a row maps the slug, and the row shows the item's name.
4. A second item can be dragged from the **same, still-open** browser onto another row, without
   reopening it, and the mapping screen stays usable throughout.
5. Re-importing a character that had that slug imports the mapped item, with no import issue.
6. The same slug on a _different_ character also resolves, without that GM mapping it twice.
7. Removing the mapping returns the slug to unmapped and it reappears as an import issue.
8. A non-GM cannot open the screen or see the button.
9. All existing behaviour is unchanged when no mappings exist.
10. The sync dialog's wording is **unchanged** after the structured-record rework (R1.6), and the
    titlebar dot still lights up for unmapped slugs.
