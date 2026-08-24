# Demiplane PF2e Sync for Foundry VTT

Build your Pathfinder 2e character on [Demiplane Nexus](https://app.demiplane.com), then bring it straight into your Foundry game. No copy-pasting stats, no manual data entry, no "wait, what level did I take Fleet at?"

Level up on Demiplane, click update in Foundry, and you're good to go.

## Why You Want This

**Players:** You already love Demiplane's character builder. Now you can use it _and_ play on Foundry without rebuilding your character by hand. Import once, and future updates are a single click.

**GMs:** Your players show up with characters that just work — ancestry, feats, equipment, skills, the whole thing. No more fixing broken sheets mid-session.

## What Gets Imported

- Ancestry, heritage, and background
- Class, subclass, and all class features
- Feats (ancestry, class, skill, general, bonus)
- Equipment and weapons
- Attribute boosts and skill proficiencies
- Spells and focus spells
- Languages
- Biography and appearance

The import builds your character the same way as if you dragged and dropped each item onto the sheet yourself. It doesn't mess with internal structures or take shortcuts, which means you're far less likely to hit weird errors during play that only happen with imported characters.

## Syncing Back to Demiplane (Future Work)

This isn't implemented yet, but it's on the roadmap. The plan is for the module to watch for changes during play and push them back to Demiplane so your character sheet stays current without you thinking about it. Planned sync targets:

- HP and temporary HP
- Hero points
- Focus points
- Currency (gold, silver, copper, platinum)
- Inventory changes (items gained, spent, or lost during a session)

For now, the module is import-only. Syncing back is coming.

## How It Works

### First Import (Usually the GM)

The first time a character is imported, the module creates a new Foundry Actor. This requires **Create Actor** permission, which most servers restrict to GMs. So the typical flow is:

1. **GM** clicks the "Import Demiplane Character" button in the Actors sidebar.
2. GM pastes the character's Demiplane URL or UUID.
3. The module creates the actor and populates everything.
4. GM assigns ownership of the actor to the player.

After that, the player can update their own character whenever they level up or make changes on Demiplane.

### Updating an Existing Character (Players Can Do This)

Once the actor exists and the player has ownership:

1. Right-click the actor in the sidebar and choose "Update from Demiplane."
2. Or open the actor sheet's **Sync** tab and click **Import from Demiplane**.

That's it. The module fetches the latest version and applies the diff.

### Linking a Character

The module needs to know which Demiplane character maps to which Foundry actor. You link them by providing either:

- The full Demiplane URL: `https://app.demiplane.com/nexus/pathfinder2e/character-sheet/...`
- Or just the UUID from that URL

You can find this by opening your character on Demiplane and copying the URL from the address bar.

## Configuration

In **Settings > Module Settings > Demiplane PF2e Sync**:

- **Demiplane GraphQL Token** — The GM must provide the shared bearer token used to access the Demiplane API. Players can use the token for imports and sync operations, but the token setting is hidden from them.

### Getting the Demiplane Token

1. Log in to [Demiplane Nexus](https://app.demiplane.com) in a desktop browser.
2. Open the browser developer tools (usually **F12** or **Cmd+Option+I**) and select the **Network** tab.
3. Open a Demiplane character sheet or refresh one that is already open.
4. Find a request to `https://apiv4.demiplane.com/v1/graphql`.
5. Open the request headers and copy the value of the `Authorization` header, without the `Bearer ` prefix.
6. In Foundry, open **Settings > Module Settings > Demiplane PF2e Sync**, paste the token into **Demiplane GraphQL Token**, and save the settings.

The token is stored as a world setting so players can import characters they own without seeing or entering the token. Demiplane tokens expire, so the GM must repeat these steps when imports begin reporting authentication errors. Treat the token like a password and do not share it outside the Foundry world.

## Conflict Detection (Future Work)

Once syncing back is implemented, the module will check whether the Demiplane character has been modified since your last sync before pushing. If there's a version mismatch, you'll get options to re-import, force push, or cancel. This prevents anyone's changes from getting silently overwritten.

## Troubleshooting

**"No Demiplane token configured"** — Ask the GM to configure the shared GraphQL token. See the Configuration section above for how to grab it from the browser.

**Some items show as unresolved after import** — A few Demiplane items may not have an exact match in the Foundry PF2e compendium yet. The import skips those and lists them on the Sync tab so you can add them manually.

## Pre-Release Notice

This module is pre-release software. It can result in data loss for the Foundry Actor, the Demiplane character, or both. Back up your world and your Demiplane characters before using it. You'll see a warning dialog each time the module loads as a reminder.

## Compatibility

- Foundry VTT v14+
- PF2e system

## License

MIT
