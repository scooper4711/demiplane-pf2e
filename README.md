# Demiplane PF2e Sync for Foundry VTT

Two-way character sync between [Demiplane Nexus](https://app.demiplane.com) and the Foundry VTT PF2e system.

Build your character on Demiplane, import it into Foundry for game sessions, and sync session state (HP, currency, hero points) back to Demiplane automatically.

## What It Does

- **Import** your Demiplane Pathfinder 2e character into an existing Foundry actor, complete with ancestry, heritage, background, class, feats, equipment, attribute boosts, and skill training.
- **Export** session state changes (HP, temporary HP, hero points, focus points, currency) back to Demiplane as you play.
- **Conflict detection** warns you when someone else has edited the character on Demiplane since your last sync, so nothing gets silently overwritten.
- **Dry run mode** lets you preview what an import or export would do before committing any changes.

## Installation

1. Download or clone this repository.
2. Run `npm install && npm run build` to produce the module bundle.
3. Copy the built module folder into your Foundry VTT modules directory:
   - **Linux:** `~/.local/share/FoundryVTT/Data/modules/foundry-demiplane-pf2e/`
   - **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/foundry-demiplane-pf2e/`
   - **Windows:** `%LOCALAPPDATA%/FoundryVTT/Data/modules/foundry-demiplane-pf2e/`
4. In Foundry, go to **Settings > Manage Modules** and enable **Demiplane PF2e Sync**.

## Configuration

### Demiplane Credentials (Optional)

Open **Settings > Module Settings** and enter your Demiplane email and password. These are stored per-client (each player enters their own) and are used to access private characters and push changes back.

If you only need to import publicly shared characters, you can leave these blank.

### Dry Run Mode

In **Settings > Module Settings**, a GM can toggle **Dry Run Mode** on or off. When enabled:

- Import and export operations run their full logic (fetching data, resolving slugs, detecting conflicts) but skip all write operations.
- No changes are made to the Foundry actor or the Demiplane character.
- The Sync tab shows a clear indicator that dry run mode is active, and buttons read "Preview Import" / "Preview Push" instead of the normal labels.

This is useful for verifying what sync would do before applying it to a real character.

## Linking a Character

Before you can sync, you need to link a Foundry actor to a Demiplane character:

1. Open the actor sheet for the character you want to link.
2. Open the character link dialog (available from the actor sheet header or context menu).
3. Enter either:
   - A bare character UUID: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
   - A full Demiplane character URL: `https://app.demiplane.com/nexus/pathfinder2e/character-sheet/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
4. Click **Link Character**.

The module validates the UUID format and checks that the character is accessible on Demiplane before saving the link. If something is wrong, you will see an error notification explaining what to fix.

To find your character UUID, open your character on Demiplane and copy the URL from your browser's address bar.

## Importing a Character

Once a character is linked:

1. Open the actor sheet and go to the **Sync** tab.
2. Click **Import from Demiplane** (or **Preview Import** in dry run mode).
3. The module fetches your character data, resolves each choice to the corresponding PF2e compendium item, and populates the actor.

The import adds items in the correct order (ancestry, heritage, background, class, then feats and equipment) so that the PF2e Grant Chain fires properly. Attribute boosts and skill training are applied after items, skipping any that are already granted by the chain.

After import, the Sync tab shows a summary with the number of items imported, items skipped (unresolved slugs), and any errors encountered.

If the actor already has items from a previous import, the module reconciles differences rather than duplicating entries.

## Exporting Session State

Session state changes sync from Foundry back to Demiplane in two ways:

### Automatic Sync

When the **Auto-sync on Actor Update** setting is enabled, the module watches for changes to:

- HP and temporary HP
- Hero points
- Focus points
- Currency (gold, silver, copper, platinum)

Changes are batched within a 2-second window and pushed as a single API call to Demiplane. The module rate-limits to at most 30 API calls per minute per character.

### Manual Push

Click **Push to Demiplane** (or **Preview Push** in dry run mode) on the Sync tab to immediately send all pending changes.

If the push fails, the module retries up to 3 times with increasing delays. If all retries fail, you will see an error notification and pending changes are retained for the next attempt.

## Conflict Detection and Resolution

Before pushing changes, the module checks whether the Demiplane character has been modified since your last sync (by comparing version numbers).

If a conflict is detected, the Sync tab shows a warning with three options:

- **Re-import** — Fetches the latest character from Demiplane, applies your current session state (HP, currency, etc.) on top, and pushes the merged result.
- **Force push** — Overwrites the Demiplane character with your local data, ignoring the remote changes.
- **Cancel** — Aborts the push and keeps both sides unchanged. Your pending changes are retained for later.

## The Sync Tab

The Sync tab on linked actor sheets shows:

- **Status:** Linked character UUID, last sync timestamp, and version numbers.
- **Pending Changes:** Any unsynchronized session state changes waiting to be pushed.
- **Issues:** Unresolved slugs from the most recent import (items that could not be matched to a PF2e compendium entry).
- **Import Summary:** Results from the last import operation.
- **Conflict Warning:** Appears when a version mismatch is detected, with resolution controls.
- **Action Buttons:** Import and Push (or Preview Import and Preview Push in dry run mode).

## Troubleshooting

**Authentication failed:** Double-check your email and password in module settings. Public characters are still accessible without credentials.

**Unresolved slugs after import:** Some Demiplane content may not have a direct match in the Foundry PF2e compendium. The import continues with available items and lists unresolved slugs on the Sync tab.

**Conflict detected on every push:** This usually means another tool or browser session is modifying the character on Demiplane. Use "Re-import" to merge or coordinate with other editors.

**Rate limit reached:** The module caps pushes at 30 per minute per character. Wait a moment and changes will sync on the next attempt.

## License

MIT
