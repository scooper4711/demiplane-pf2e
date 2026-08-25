# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
