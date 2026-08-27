# Contributing to foundry-demiplane-pf2e

Thank you for your interest in improving the Demiplane-Foundry PF2e sync module. This guide covers everything you need to get started.

## Prerequisites

- **Node.js 20+** (check with `node --version`)
- **Foundry VTT** with the PF2e game system installed (for integration testing)
- **Git** with commit signing configured (`git config commit.gpgsign true`)

## Development Environment Setup

1. Clone the repository and the companion API library:

   ```bash
   git clone git@github.com:scooper4711/demiplane-pf2e.git
   git clone git@github.com:scooper4711/demiplane-api.git
   ```

2. Install dependencies for both packages:

   ```bash
   cd demiplane-api
   npm install

   cd ../demiplane-pf2e
   npm install
   ```

3. Start the build watcher for development:

   ```bash
   npm run build:watch
   ```

   This uses Rollup to bundle the module. The output goes to `dist/` and can be symlinked into your Foundry modules directory.

4. Link the built module into Foundry VTT:

   ```bash
   ln -s /path/to/demiplane-pf2e/dist /path/to/foundry-data/Data/modules/foundry-demiplane-pf2e
   ```

## Project Structure

```
demiplane-pf2e/
  src/
    module.ts                  # Module entrypoint - wires all components
    settings.ts                # Foundry module settings registration
    slug-mapper.ts             # Demiplane slug -> Foundry compendium resolution
    import-orchestrator.ts     # Full character import pipeline
    export-manager.ts          # Debounced session state export
    conflict-resolver.ts       # Version-based conflict detection
    hook-manager.ts            # Foundry hook registration and dispatch
    sync-issues.ts               # Import/export sync-issue sets on linked actors
    titlebar-dot.ts              # Red titlebar indicator for open sync issues
    demiplane-info-button.ts     # Demiplane dialog (lists + dismisses issues)
    character-link-input.ts    # UUID/URL parsing for actor linking
    character-link-dialog.ts   # Per-actor character link dialog
    attribute-skill-importer.ts # Attribute boost and skill training logic
  tests/
    unit/                      # Unit tests (specific examples, edge cases)
    property/                  # Property-based tests (universal correctness)
  docs/
    ARCHITECTURE.md            # Data flow, hooks, slug mapping internals
    DESIGN.md                  # Design decisions and rationale
    CONTRIBUTING.md            # This file
```

## Running Tests

```bash
# Run the full test suite once
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

Tests use **Vitest** as the test runner and **fast-check** for property-based tests. The test directory mirrors the source structure with `tests/unit/` for unit tests and `tests/property/` for property-based tests.

## Code Style

### TypeScript

- **Strict mode** enabled with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noUnusedLocals`
- Target ES2022, ESNext modules with Bundler resolution

### Linting and Formatting

```bash
# Run the linter
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Check formatting
npm run format:check

# Fix formatting
npm run format
```

ESLint with `typescript-eslint` handles code quality rules. Prettier handles formatting. Both must pass before pushing.

### Clean Code Principles

- Functions do one thing, ideally under 20 lines
- Intention-revealing names: classes are nouns, functions are verbs
- No abbreviations; prefer descriptive names over short ones
- Exceptions over return codes; include context with errors
- Don't return or pass null; use `undefined`, empty arrays, or the Optional pattern
- Named constants over magic numbers
- Avoid negative conditionals (`isValid()` over `!isInvalid()`)

## Adding Support for a New Character Class

The module's import pipeline is class-agnostic by design. The `SlugMapper` resolves any class slug from the `pf2e.classes` compendium, and the `ImportOrchestrator` handles sequencing automatically. However, some classes have unique data patterns that may need attention.

### What to check

1. **Slug mapping** (`src/slug-mapper.ts`): Verify the class slug resolves correctly. Demiplane uses `-rm` suffixes for Remastered content (e.g., `fighter-rm` becomes `fighter`). If the class has an unusual slug, add a test case.

2. **Class features** (`src/import-orchestrator.ts`): The orchestrator categorizes engine entries by their path prefix. Class features use the `classfeatures` pack. Confirm the new class's features follow the standard naming pattern (`tabula/classfeature/...`).

3. **Spellcasting**: If the class has spells, verify that spell engines (path pattern `tabula/spell/...`) resolve correctly through the `pf2e.spells-srd` compendium pack.

4. **Attribute boosts and skills** (`src/attribute-skill-importer.ts`): Class-granted boosts and skill increases should be handled by the Grant Chain. The importer skips duplicates already present on the actor. Verify no double-application occurs.

### What files to modify

| Scenario               | File                                               |
| ---------------------- | -------------------------------------------------- |
| Slug doesn't resolve   | Check `slug-mapper.ts` pack search order           |
| Engine not categorized | Update category logic in `import-orchestrator.ts`  |
| Grant Chain conflict   | Adjust skip logic in `attribute-skill-importer.ts` |

### What tests to add

- Unit test in `tests/unit/` verifying the class slug resolves from the compendium mock
- Unit test verifying class features import in the correct sequence
- If the class has unique behavior, add a property test in `tests/property/` validating the invariant

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/) with signed commits.

### Format

```
<type>: <Subject in imperative mood>
```

### Types

| Type       | Use for                                               |
| ---------- | ----------------------------------------------------- |
| `feat`     | New features or capabilities                          |
| `fix`      | Bug fixes                                             |
| `refactor` | Code changes that neither fix a bug nor add a feature |
| `docs`     | Documentation changes                                 |
| `test`     | Adding or updating tests                              |
| `chore`    | Build, tooling, dependency updates                    |
| `style`    | Formatting, whitespace (no logic change)              |

### Rules

- Subject line: capitalize after prefix, imperative mood, no period, max 72 characters
- Body (optional): blank line after subject, wrap at 72 characters, explain what and why
- All commits must be signed: `git commit -S`
- Commits should be small, focused, and represent one coherent unit of work

### Examples

```
feat: Add wizard spellbook import support
fix: Resolve duplicate feat detection during Grant Chain reconciliation
docs: Update ARCHITECTURE.md with spell slot export flow
```

## Pull Request Process

1. **Branch from main** using a conventional branch name:
   - `feat/<name>` for features
   - `fix/<name>` for bug fixes
   - `refactor/<scope>` for refactoring

2. **Keep commits small and focused.** Each commit should represent one logical change. Implementation and its tests belong in the same commit.

3. **Before pushing, verify:**
   - `npm run lint` passes with no errors
   - `npm test` passes with all tests green
   - TypeScript compiles cleanly: `npm run typecheck`

4. **PR description should include:**
   - Summary of what changed and why
   - Which requirements or design decisions are addressed
   - How the change was tested

5. **Merge strategy:** `git merge --no-ff` to preserve branch history with a conventional commit message.

## Questions?

Open an issue or reach out to the maintainer. When filing a bug, include the Foundry VTT version, PF2e system version, and any relevant console output.
