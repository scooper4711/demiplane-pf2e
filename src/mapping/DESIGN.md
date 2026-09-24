# `mapping` package

Slug → compendium-UUID store plus its share helpers, compendium-discovery
seams, and the GM editor app. Depends on `core` and `sync` only (enforced
by `mapping-depends-inward`). Consumed by `import/` resolution (via this
barrel) and by `ui/` settings/dialogs.

## Responsibility

Make every Demiplane name resolve to the right compendium entry exactly
once, remember the answer, and let the GM see and correct it. See
[DESIGN §18–§22](../../../docs/DESIGN.md#18-unmapped-slugs-as-structured-records)
and [DESIGN-slug-mapping.md](../../../docs/DESIGN-slug-mapping.md).

## Public surface

`index.ts` is authoritative (10 names).

| From                       | Role                                                                     | Names                                                                                         |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `slug-mapping.ts`          | Per-kind world-settings store (GM overrides + recorded auto-resolutions) | `getMapping`, `resolveMappedItem`, `recordResolvedMapping`, `registerSlugMappingSettings`     |
| `pack-discovery.ts`        | Which packs hold items of given types (PF2e-browser-style scan)          | `findPacksWithItemTypes`                                                                      |
| `pack-index.ts`            | Typed compendium-index seam (narrows the `any` system payload)           | `getPackIndex`, `PackIndex`                                                                   |
| `demiplane-mapping-app.ts` | GM "Demiplane Mapping" editor app + live sync hook                       | `getDemiplaneMappingAppClass`, `registerDemiplaneMappingTemplates`, `registerMappingSyncHook` |

Internal (not exported): `mapping-share.ts` (`exportAction`/`importAction`
file round-trip) is used only by the editor app.

## How it works

- **Precedence:** `resolveMappedItem` is consulted before any compendium
  scan and wins — even over a slug that would resolve on its own — so a GM
  can override wrong-but-successful matches. A mapping whose target
  vanished returns null and falls through to a fresh lookup.
- **Recording:** every successful fallback resolution is recorded
  non-clobberingly, so the store doubles as a lookup cache and the editor
  can show the full mapping list (filterable to unmapped-only).
- **Discovery:** `pack-discovery.ts` groups every visible Item pack's index
  by item type, so third-party packs appear alongside official ones for
  both the editor's browse buttons and the import fallback. `pack-index.ts`
  is the one typed seam over `getIndex` (see DESIGN §23).
- **Live sync:** `registerMappingSyncHook` refreshes an open editor on
  `updateSetting`, so a mapping changed on one client appears on every
  other client immediately.

## Constraints

- Depends only on `core` and `sync`. It must never import `import/`,
  `export/`, or `ui/` — the discovery seams moved _into_ this package
  precisely to keep that edge one-directional (`import/` → `mapping/`).
