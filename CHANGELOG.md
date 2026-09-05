# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.11] - 2026-09-05

### Added

- two-way sync for item investment
- flag unresolved ChoiceSets as sync issues

### Fixed

- scope and suffix-strip ChoiceSet feat matching
- resolve weapon property runes generally, with validation
- affix weapon runes to the weapon instead of importing them separately
- check sync-active before the auto-sync note in change hooks

### Changed

- deleted playwright bookeeping noise
- add E2E coverage tooling dependencies
- stabilize and extend the Playwright integration suite

[0.2.0-beta.11]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.11

## [0.2.0-beta.10] - 2026-09-04

### Fixed

- place free-archetype feats in the archetype slots
- place mythic feats in the mythic slots
- route ancestry boosts to free slots and support alternate boosts
- use Demiplane level group for gradual boost buckets
- apply level 5/10/15 attribute boosts
- resolve innate spells from add-feat grants

### Changed

- minor wording fix

[0.2.0-beta.10]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.10

## [0.2.0-beta.9] - 2026-09-04

### Added

- show pre-release warning only on beta and dev builds

### Fixed

- include templates and assets in release archive
- grant background lore when the engine has no slug
- resolve SonarQube warnings in module test and spell entry
- resolve @scooper4711/demiplane-api from node_modules under vitest 4

### Changed

- clarify GM value, linking, and roadmap; refresh .env.example
- elminate lint error
- normalize package-lock optional dependency metadata
- cover mapping app, matchers, and remaining sub-60 files
- cover import phases to lift branch coverage over 80%
- decompose module entrypoint into testable units
- bump the dev-minor-patch group across 1 directory with 2 updates
- make coverage non-blocking temporarily under vitest 4
- guard against local demiplane-api references in pre-commit
- bump the dev-major group with 6 updates
- lock TypeScript to 6.x in Dependabot
- added license
- updated readme to reflect current state
- bump qs from 6.15.3 to 6.16.0

[0.2.0-beta.9]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.9

## [0.2.0-beta.8] - 2026-09-04

### Added

- Bound the Demiplane dialog's issue lists in a scroll region
- Show blue/red Demiplane logo as the sync indicator
- Use libWrapper for ChoiceSet patch when available
- Record all slug resolutions and rework the mapping editor

### Fixed

- use console.log for debug output to avoid stack traces
- Live-update the mapping editor when another client changes a mapping

### Changed

- removed movie file in favor of attachment
- working on video demo
- Remove dead code and extract PF2e magic-number constants
- Lint-guard `as unknown as` and `as never` casts
- Centralize residual type casts behind access seams
- migrate from fvtt-types to @dfreds/foundry-types
- removed kiro documents
- address Sonarqube findings to improve maintanability
- Resolve mapping icons from the pack index instead of full documents
- Open the mapping editor instantly with a loading state
- Update ARCHITECTURE and DESIGN for spell/choice-set refactor
- Split spell-importer and choice-set-handler god objects

[0.2.0-beta.8]: https://github.com/scooper4711/demiplane-pf2e/releases/tag/v0.2.0-beta.8

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
