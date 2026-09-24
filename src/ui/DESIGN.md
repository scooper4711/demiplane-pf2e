# `ui` package

Presentation and wiring only: dialogs, buttons, icons, settings, and the
public module API. May depend on any package via its barrel; no package
may depend on `ui` (there is no corresponding allow-rule — nothing outside
`module.ts` imports it). The composition root `src/module.ts` is the sole
importer. See [DESIGN §24](../../../docs/DESIGN.md#24-module-entrypoint-decomposition).

## Responsibility

Render every user-facing surface of the module and translate user gestures
into `flows/` calls. This package owns no sync state and makes no sync
decisions — it reads `sync/` (link state, issues, write level) and calls
the `ImportCharacterFn` / `ExportCharacterFn` functions handed in at
registration time.

## Public surface

`index.ts` is authoritative (9 names) — one registration entry point per
surface, all taking their flow collaborators as parameters:

| From                       | Role                                                     | Names                                        |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `settings.ts`              | World settings + settings-dialog UX                      | `registerSettings`                           |
| `module-api.ts`            | External `game.modules` API with guard notifications     | `registerModuleApi`                          |
| `demiplane-info-button.ts` | Sheet header button + full sync dialog                   | `registerDemiplaneInfoButton`                |
| `character-link-dialog.ts` | Per-actor link/unlink dialog                             | `CharacterLinkDialog`                        |
| `character-link-input.ts`  | Pure UUID/URL parser (no Foundry deps)                   | — (consumed inside this package only)        |
| `directory-import.ts`      | Sidebar import flow (prompt, dedupe, create+link+import) | `canImportCharacters`, `onImportButtonClick` |
| `directory-icon.ts`        | Actors-sidebar badge + click-through                     | `registerDirectoryIcon`                      |
| `actor-context-menu.ts`    | "Update from Demiplane" context entry                    | `buildUpdateFromDemiplaneOption`             |
| `titlebar-dot.ts`          | Error indicator class on sheet titlebars                 | `registerTitlebarDot`                        |

## How it works

- `module.ts` constructs the singletons (`DemiplaneClient`,
  `ImportOrchestrator`, `ExportManager`, `HookManager`), binds them into
  `importFn`/`exportFn` closures evaluated at call time (registration
  happens before `ready` assigns the singletons), and passes those into
  each `register*` function. UI modules never read module globals.
- Dialogs that need data (`demiplane-info-button`) read the `sync/` issue
  store and the `mapping/` store; they never write sync state except
  through acknowledgement actions and `flows/` calls.
- While an actor is sync-paused, entry points go inactive with reasons
  (greyed menu option, disabled dialog buttons) rather than merely
  refusing — see DESIGN §16.

## Constraints

- Leaf package: anything here that another package needs is a misplaced
  responsibility — move the logic down, keep the rendering here.
- Flow function types (`ImportCharacterFn`/`ExportCharacterFn`) are
  imported from `flows/`; two dialogs redeclare narrow local structural
  equivalents where they only need a subset — do not widen those without
  reason.
