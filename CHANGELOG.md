# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.7] - 2026-09-02

### Added

- Show the sidebar Demiplane icon only to GMs and owners
- Open the Demiplane dialog from the sidebar icon
- Show Demiplane icon on linked actors in sidebar
- Add dump_character_journals MCP tool
- Sync biography Campaign Notes with Demiplane journal
- two-way sync for organized play ID
- export biography fields from Foundry to Demiplane
- add semicolon as list separator for languages, edicts, and anathema
- add Demiplane MCP server and CLI utility
- added a mapping editor for demiplane slugs
- add GM slug mapping screen
- resolve GM-defined slug mappings ahead of the compendium

### Fixed

- Prevent two actors linking the same Demiplane character
- Open compendium pack window for browserless mapping kinds
- resolve SonarCloud issues across sources and tests

### Changed

- Drop the word "slug" from user-facing text
- Document GM-only Demiplane item mapping
- Cover the Actors sidebar Demiplane icon
- Match Demiplane Mapping screen to PF2e inventory
- Enforce 80% coverage on push
- fold slug mapping decisions into DESIGN.md
- store unmapped slugs as structured records

[0.2.0-beta.7]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.7

## [0.2.0-beta.6] - 2026-08-30

### Added

- hide Demiplane titlebar button + red dot from non-GM/non-owners
- permission-gate UI, opt-in pre-release warning, single-writer push election

### Fixed

- import scrolls and wands with the spells they carry
- stop importing from pushing deletions back to Demiplane
- import domain focus spells, leave focus pool to the system
- pause pushing across all clients during an in-flight import or push
- re-baseline conflict state from server after push to stop false re-imports
- reflect pushed field changes and ignore benign Demiplane updated bumps
- refresh lastUpdated after push to prevent false-conflict re-import
- import lore before feat grants and de-duplicate native-granted feats
- import commander class feats and args-slug-less equipment
- import cleric prepared spells and Divine Font from Demiplane

### Changed

- attempt 3 to get video in readme
- validate mermaid diagrams as part of pre-commit hook
- drop unnecessary 'as never' on getIndex({ fields }) calls
- lock in ImportOrchestrator thin-driver lastImportTimestamp stamp
- document conflict-resolution heuristic in DESIGN.md
- narrow module api to intent-level methods
- reconcile ARCHITECTURE/DESIGN/CONTRIBUTING with current code
- route diagnostic console.warn through debugLog
- reflect ImportPhase pipeline in ARCHITECTURE.md
- decompose orchestrator into ordered ImportPhase pipeline
- reflect ChangeBuffer/PushPayloadBuilder/ConflictResolver export collaborators
- extract ConflictResolver from ExportManager
- extract PushPayloadBuilder from ExportManager
- extract ChangeBuffer from ExportManager
- centralize magic strings into src/config.ts
- harvest attribute/skill validation tables
- extract shared stream-engines fetch + spell compendium resolver
- address P0 correctness findings (idempotent patch, per-character suspend, shared delete)
- remove dead code and lift all-src coverage above 80%
- remove dead code and lift all-src coverage above 80%
- raise import-module coverage above 80%
- tweaking video link to make embedded video work
- fixed badges (typo)
- add badges
- fix mermaid syntax error

[0.2.0-beta.6]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.6

## [0.2.0-beta.5] - 2026-08-28

### Added

- propagate item deletions from Foundry to Demiplane
- implement optimistic locking on push with server-updated check and auto re-import

### Fixed

- stop bumping lastUpdated on Foundry pushes
- import bolts and sync quantity for single items

### Changed

- updated to latest versions of libraries
- clarify character-import template with expected actor export
- bump @scooper4711/demiplane-api to 0.3.0

[0.2.0-beta.5]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.5

## [0.2.0-beta.4] - 2026-08-27

### Added

- add red sync-issue indicator to linked actor sheets
- Sync hand slots and armor in-slot state to Demiplane
- Sync item quantity and equipped state to Demiplane
- Push session state changes to Demiplane via updateCharacterV2
- Add Demiplane info button to actor sheet header

### Fixed

- Detect currency changes via treasure items instead of system.currency
- Delete items with empty module flag namespace on re-import

### Changed

- Split push payload builder into focused helpers
- Split long import functions and drop max-lines/complexity overrides
- Remove dry run feature entirely
- Gate detail logging behind debug setting; add per-op pull/push logs
- Remove focus points sync due to Demiplane tracking bug
- updates docs to reflect more user-friendly way to get auth token
- removed dead code for conflict resolution
- Updated architecture and design docs based on latest changes
- Add GitHub issue templates for bug reports, imports, and features

[0.2.0-beta.4]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.4

## [0.2.0-beta.3] - 2026-08-25

### Changed

- Update demiplane-api to published npm package v0.2.0

[0.2.0-beta.3]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.3

## [0.2.0-beta.2] - 2026-08-25

### Added

- Add item spellcasting entries for staves and wands
- Add post-delete logging to show remaining items on actor
- Add feature-granted spell resolution from stream-engines
- Add curriculum entry, prepared placement, and signature spells
- Wire spell slot resolver into spell importer with logging
- Add spell slot resolver for stream-engines and user overrides
- Migrate dialogs to Foundry v14 DialogV2 API and improve type safety
- Migrate to Foundry v14 DialogV2 API and update type definitions
- Delegate class features to PF2e GrantItem rules
- Switch to GM-configured token auth with validation and debug logging

### Fixed

- Resolve ChoiceSet selections for generic-feature and generic-choice engines
- Name focus spell entry after source feature
- Prevent duplicate Assurance feat from GrantItem double-resolution
- Curriculum slot resolution, innate entry naming, hide slotless levels
- Set spell slot value to max on import (full slots available)
- Explain saving before token validation
- Update module ID and paths in setup script for consistency

### Changed

- Add cross-VTT selling point to README
- Add tests for curriculum separation, prepared placement, and signature spells
- Add spell slot progression and spell import specs
- Add Demiplane API steering document
- Upgrade fvtt-types to v14 and update related dependencies

[0.2.0-beta.2]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.2

## [0.2.0-beta.1] - 2026-08-22

### Added

- Add pre-release warning dialog on module initialization

### Changed

- Add Foundry VTT development scripts to package.json
- Rewrite README with user-focused language and clearer structure
- Update minimum Foundry VTT compatibility to v14
- corrected the sonar-project-properties so reports are sent to the right place

[0.2.0-beta.1]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.1

## [0.1.0] - 2026-08-22

### Added

- Initial release

[0.1.0]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.1.0
